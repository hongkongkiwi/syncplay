# coding:utf8

import time
import uuid
from collections import namedtuple

from syncplay.filetransfer import (
    TransferSession,
    TransferStatus,
    TransferValidationError,
    normalize_transfer_filename,
    validate_resume_offset,
    validate_transfer_request,
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
        self.cleanup_expired_sessions()
        if not self.config.enabled:
            self._send_error(receiver, None, "file-transfer-disabled", "File transfers are disabled on this server.")
            return None
        if len(self._sessions) >= self.config.max_active:
            self._send_error(receiver, None, "too-many-active-transfers", "Too many file transfers are active.")
            return None

        source = self._find_watcher(payload.get("source"))
        if not source:
            self._send_error(receiver, None, "source-not-found", "Source user is not available.")
            return None
        if self._active_count_for(source.getName()) >= self.config.max_per_user or self._active_count_for(receiver.getName()) >= self.config.max_per_user:
            self._send_error(receiver, None, "too-many-user-transfers", "Too many file transfers are active for this user.")
            return None
        file_ = source.getFile()
        validation_file = dict(file_ or {}, path="/server/metadata-check")
        try:
            request = validate_transfer_request(source, receiver, validation_file, self.config)
        except TransferValidationError as error:
            code, message = self._validation_error(str(error))
            self._send_error(receiver, None, code, message)
            return None

        try:
            offset = int(payload.get("offset") or 0)
            validate_resume_offset(offset, request.size)
        except Exception:
            self._send_error(receiver, None, "bad-offset", "Transfer offset is invalid.")
            return None

        transfer_id = uuid.uuid4().hex
        session = TransferSession(
            transfer_id=transfer_id,
            source=request.source,
            receiver=request.receiver,
            room=request.room,
            filename=request.filename,
            duration=file_.get("duration"),
            size=request.size,
            chunk_size=self.config.chunk_size,
            offset=offset,
            fingerprint=None,
            status=TransferStatus.WAITING_FOR_APPROVAL,
        )
        self._sessions[transfer_id] = session
        offer_payload = {
            "transferId": transfer_id,
            "source": source.getName(),
            "receiver": receiver.getName(),
            "file": self._public_file(file_),
            "offset": session.offset,
        }
        receiver_features = receiver.getFeatures() if hasattr(receiver, "getFeatures") else {}
        if receiver_features.get("webrtc"):
            offer_payload["supportWebRTC"] = True
        source.sendTransferOffer(offer_payload)
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
            self._pause(session, TransferStatus.PAUSED_RECEIVER_OFFLINE, source, "receiver-offline", "Receiver is offline.")
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
        if not self._is_participant(watcher, session):
            self._send_error(watcher, transfer_id, "not-participant", "Only transfer participants can pause this transfer.")
            return None
        session = session._replace(status=TransferStatus.PAUSED_LOCAL)
        self._sessions[transfer_id] = session
        for participant in self._participants(session):
            if hasattr(participant, "sendTransferPause"):
                participant.sendTransferPause(transfer_id, reason or "Transfer paused.", session.offset)
        return session

    def resume_transfer(self, watcher, transfer_id, offset, fingerprint):
        session = self._sessions.get(transfer_id)
        if not session:
            self._send_error(watcher, transfer_id, "not-found", "Transfer was not found.")
            return None
        if not self._is_participant(watcher, session):
            self._send_error(watcher, transfer_id, "not-participant", "Only transfer participants can resume this transfer.")
            return None
        source = self._find_watcher(session.source)
        receiver = self._find_watcher(session.receiver)
        if not receiver:
            self._pause(session, TransferStatus.PAUSED_RECEIVER_OFFLINE, source, "receiver-offline", "Receiver is offline.")
            return session
        if not source or not source.getFile() or int(source.getFile().get("size", -1)) != session.size or fingerprint != session.fingerprint:
            self._send_error(watcher, transfer_id, "source-changed-media", "Source changed media.")
            session = session._replace(status=TransferStatus.PAUSED_SOURCE_CHANGED_MEDIA)
            self._sessions[transfer_id] = session
            return session
        try:
            validate_resume_offset(offset, session.size)
        except Exception:
            self._send_error(watcher, transfer_id, "bad-offset", "Transfer offset is invalid.")
            return session
        session = session._replace(offset=int(offset), status=TransferStatus.APPROVED)
        self._sessions[transfer_id] = session
        sender_ticket = self._ticket(session, "sender")
        receiver_ticket = self._ticket(session, "receiver")
        source.sendTransferResume(transfer_id, session.offset, session.fingerprint)
        receiver.sendTransferResume(transfer_id, session.offset, session.fingerprint)
        source.sendTransferTicket(sender_ticket)
        receiver.sendTransferTicket(receiver_ticket)
        return session

    def cancel_transfer(self, watcher, transfer_id, reason):
        session = self._sessions.get(transfer_id)
        if not session:
            self._send_error(watcher, transfer_id, "not-found", "Transfer was not found.")
            return None
        if watcher.getName() not in (session.source, session.receiver):
            self._send_error(watcher, transfer_id, "not-participant", "Only transfer participants can cancel this transfer.")
            return None
        self._sessions.pop(transfer_id, None)
        for participant in self._participants(session):
            self._send_error(participant, transfer_id, "cancelled", reason or "Transfer cancelled.")
        return session

    def report_progress(self, transfer_id, transferred):
        session = self._sessions.get(transfer_id)
        if not session:
            return None
        try:
            transferred = int(transferred)
        except (TypeError, ValueError):
            return None
        payload = {
            "transferId": transfer_id,
            "transferred": min(max(transferred, 0), session.size),
            "size": session.size,
            "status": TransferStatus.DOWNLOADING if transferred < session.size else TransferStatus.COMPLETE,
        }
        for participant in self._participants(session):
            participant.sendTransferProgress(payload)
        if payload["status"] == TransferStatus.COMPLETE:
            self._sessions.pop(transfer_id, None)
        else:
            self._sessions[transfer_id] = session._replace(status=TransferStatus.DOWNLOADING, offset=payload["transferred"])
        return payload

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
        expired_transfer_ids = set()
        for token in expired:
            expired_transfer_ids.add(self._tokens[token]["transferId"])
            del self._tokens[token]
        for transfer_id in expired_transfer_ids:
            if not any(details["transferId"] == transfer_id for details in self._tokens.values()):
                self._sessions.pop(transfer_id, None)

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
            "file": {"name": session.filename, "duration": session.duration or 0, "size": session.size},
            "fingerprint": session.fingerprint,
        }

    def _pause(self, session, status, notify, code, message):
        session = session._replace(status=status)
        self._sessions[session.transfer_id] = session
        if notify:
            self._send_error(notify, session.transfer_id, code, message)
        return session

    def _participants(self, session):
        return [watcher for watcher in (self._find_watcher(session.source), self._find_watcher(session.receiver)) if watcher]

    def _is_participant(self, watcher, session):
        return watcher and watcher.getName() in (session.source, session.receiver)

    def _active_count_for(self, username):
        return len([session for session in self._sessions.values() if session.source == username or session.receiver == username])

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

    def _validation_error(self, message):
        if "same room" in message:
            return "not-same-room", "Source and receiver must be in the same room."
        if "larger" in message:
            return "file-too-large", "File is larger than the server transfer limit."
        return "file-not-shareable", "Source file is not shareable."

    def _public_file(self, file_):
        return {
            "name": normalize_transfer_filename(file_["name"]),
            "duration": file_.get("duration"),
            "size": int(file_["size"]),
        }
