# coding:utf8

import time
import uuid
from collections import namedtuple

from syncplay.filetransfer import (
    TransferSession,
    TransferStatus,
    is_shareable_loaded_file,
    normalize_transfer_filename,
    validate_resume_offset,
)


TransferServerConfig = namedtuple(
    "TransferServerConfig",
    [
        "enabled",
        "max_size",
        "max_active",
        "max_per_user",
        "rate_limit",
        "token_ttl",
        "chunk_size",
    ],
)
TransferServerConfig.__new__.__defaults__ = (False, 2147483648, 4, 1, None, 600, 262144)


class TransferManager(object):
    def __init__(self, config=None, watchers=None, now=None, token_factory=None, token_observer=None):
        self.config = config or TransferServerConfig()
        self._watchers = watchers or []
        self._sessions = {}
        self._tokens = {}
        self._now = now or time.time
        self._token_factory = token_factory or (lambda: uuid.uuid4().hex)
        self._token_observer = token_observer

    def get_session(self, transfer_id):
        return self._sessions.get(transfer_id)

    def request_transfer(self, receiver, payload):
        if not self.config.enabled:
            self._send_error(receiver, None, "file-transfer-disabled", "File transfers are disabled on this server.")
            return None

        source = self._find_watcher(payload.get("source"))
        if not source:
            self._send_error(receiver, None, "source-not-found", "Source user is not available.")
            return None
        if self._room_name(source) != self._room_name(receiver):
            self._send_error(receiver, None, "not-same-room", "Source and receiver must be in the same room.")
            return None
        file_ = source.getFile()
        if not self._is_shareable_server_file(file_):
            self._send_error(receiver, None, "file-not-shareable", "Source file is not shareable.")
            return None

        size = int(file_["size"])
        if size > self.config.max_size:
            self._send_error(receiver, None, "file-too-large", "File is larger than the server transfer limit.")
            return None

        transfer_id = payload.get("transferId") or uuid.uuid4().hex
        session = TransferSession(
            transfer_id=transfer_id,
            source=source.getName(),
            receiver=receiver.getName(),
            room=self._room_name(receiver),
            filename=normalize_transfer_filename(file_["name"]),
            size=size,
            chunk_size=self.config.chunk_size,
            offset=int(payload.get("offset") or 0),
            fingerprint=None,
            status=TransferStatus.WAITING_FOR_APPROVAL,
        )
        self._sessions[transfer_id] = session
        source.sendTransferOffer({
            "transferId": transfer_id,
            "source": source.getName(),
            "receiver": receiver.getName(),
            "file": self._public_file(file_),
            "offset": session.offset,
        })
        return session

    def accept_transfer(self, source, transfer_id, fingerprint):
        session = self._sessions.get(transfer_id)
        if not session:
            self._send_error(source, transfer_id, "not-found", "Transfer was not found.")
            return None
        if session.source != source.getName():
            self._send_error(source, transfer_id, "not-source", "Only the source can accept this transfer.")
            return None

        receiver = self._find_watcher(session.receiver)
        if not receiver:
            self._pause(session, "paused-receiver-offline", source, "receiver-offline", "Receiver is offline.")
            return None

        session = session._replace(fingerprint=fingerprint, status=TransferStatus.APPROVED)
        self._sessions[transfer_id] = session
        sender_ticket = self._ticket(session, "sender")
        receiver_ticket = self._ticket(session, "receiver")
        source.sendTransferTicket(sender_ticket)
        receiver.sendTransferTicket(receiver_ticket)
        return session

    def reject_transfer(self, source, transfer_id, reason):
        return self.cancel_transfer(source, transfer_id, reason or "rejected")

    def pause_transfer(self, watcher, transfer_id, reason):
        session = self._sessions.get(transfer_id)
        if not session:
            self._send_error(watcher, transfer_id, "not-found", "Transfer was not found.")
            return None
        return self._pause(session, "paused-local", watcher, "paused", reason or "Transfer paused.")

    def resume_transfer(self, watcher, transfer_id, offset, fingerprint):
        session = self._sessions.get(transfer_id)
        if not session:
            self._send_error(watcher, transfer_id, "not-found", "Transfer was not found.")
            return None
        source = self._find_watcher(session.source)
        if not source or not source.getFile() or int(source.getFile().get("size", -1)) != session.size or fingerprint != session.fingerprint:
            self._send_error(watcher, transfer_id, "source-changed-media", "Source changed media.")
            session = session._replace(status=TransferStatus.PAUSED_SOURCE_CHANGED_MEDIA)
            self._sessions[transfer_id] = session
            return session
        validate_resume_offset(offset, session.size)
        session = session._replace(offset=int(offset), status=TransferStatus.APPROVED)
        self._sessions[transfer_id] = session
        return session

    def cancel_transfer(self, watcher, transfer_id, reason):
        session = self._sessions.pop(transfer_id, None)
        if not session:
            self._send_error(watcher, transfer_id, "not-found", "Transfer was not found.")
            return None
        for participant in self._participants(session):
            self._send_error(participant, transfer_id, "cancelled", reason or "Transfer cancelled.")
        return session

    def handle_watcher_left(self, watcher):
        for session in list(self._sessions.values()):
            if session.source == watcher.getName():
                receiver = self._find_watcher(session.receiver)
                self._pause(session, TransferStatus.PAUSED_SOURCE_OFFLINE, receiver, "source-offline", "Source is offline.")
            elif session.receiver == watcher.getName():
                source = self._find_watcher(session.source)
                self._pause(session, TransferStatus.PAUSED_RECEIVER_OFFLINE, source, "receiver-offline", "Receiver is offline.")

    def handle_watcher_file_changed(self, watcher):
        for session in list(self._sessions.values()):
            if session.source == watcher.getName():
                receiver = self._find_watcher(session.receiver)
                self._pause(session, TransferStatus.PAUSED_SOURCE_CHANGED_MEDIA, receiver, "source-changed-media", "Source changed media.")

    def cleanup_expired_sessions(self, now=None):
        now = self._now() if now is None else now
        expired = [token for token, details in self._tokens.items() if details["expires"] <= now]
        for token in expired:
            del self._tokens[token]

    def _ticket(self, session, role):
        token = self._token_factory()
        self._tokens[token] = {
            "transferId": session.transfer_id,
            "role": role,
            "expires": self._now() + self.config.token_ttl,
        }
        if self._token_observer:
            self._token_observer(token, session.transfer_id, role)
        return {
            "transferId": session.transfer_id,
            "role": role,
            "host": None,
            "port": None,
            "token": token,
            "offset": session.offset,
            "chunkSize": session.chunk_size,
        }

    def _pause(self, session, status, notify, code, message):
        session = session._replace(status=status)
        self._sessions[session.transfer_id] = session
        if notify:
            self._send_error(notify, session.transfer_id, code, message)
        return session

    def _participants(self, session):
        return [watcher for watcher in (self._find_watcher(session.source), self._find_watcher(session.receiver)) if watcher]

    def _find_watcher(self, username):
        watchers = self._watchers() if callable(self._watchers) else self._watchers
        for watcher in watchers:
            if watcher.getName() == username:
                return watcher
        return None

    def _room_name(self, watcher):
        room = watcher.getRoom()
        return room.getName() if room else None

    def _send_error(self, watcher, transfer_id, code, message):
        if watcher:
            watcher.sendTransferError(transfer_id, code, message)

    def _is_shareable_server_file(self, file_):
        if not file_:
            return False
        if is_shareable_loaded_file(dict(file_, path="/server/metadata-check")):
            return True
        return False

    def _public_file(self, file_):
        return {
            "name": normalize_transfer_filename(file_["name"]),
            "duration": file_.get("duration"),
            "size": int(file_["size"]),
        }
