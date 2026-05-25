# coding:utf8

import hashlib
import json
import os
from collections import namedtuple

from twisted.internet import reactor
from twisted.internet.protocol import Protocol

from syncplay.filetransfer_wire import FRAME_COMPLETE, FRAME_DATA, TransferFrame, TransferFrameError, decode_frame, encode_frame


TransferClientSession = namedtuple(
    "TransferClientSession",
    [
        "transfer_id",
        "role",
        "status",
        "source",
        "receiver",
        "file",
        "ticket",
        "destination_path",
        "part_path",
        "fingerprint",
        "bytes_transferred",
        "chunk_size",
        "approved_local_path",
    ],
)
TransferClientSession.__new__.__defaults__ = (None, None, None, None, None, None, None, None, None, None, 0, None, None)


class FileTransferClient(object):
    def __init__(self, client, download_directory=None, threaded_upload=False):
        self._client = client
        self._sessions = {}
        self._download_directory = download_directory
        self._threaded_upload = threaded_upload

    def get(self, transfer_id):
        return self._sessions.get(transfer_id)

    def requestDownload(self, sourceUser):
        self._client._protocol.sendTransferRequest(sourceUser, 0)

    def handleTransfer(self, payload):
        if "offer" in payload:
            self.handleOffer(payload["offer"])
        elif "ticket" in payload:
            self.handleTicket(payload["ticket"])
        elif "progress" in payload:
            self.handleProgress(payload["progress"])
        elif "error" in payload:
            self.handleError(payload["error"])

    def handleOffer(self, payload):
        transfer_id = payload["transferId"]
        self._sessions[transfer_id] = TransferClientSession(
            transfer_id=transfer_id,
            role="sender",
            status="incoming-request",
            source=payload.get("source"),
            receiver=payload.get("receiver"),
            file=payload.get("file"),
        )
        self._prompt_incoming_offer(transfer_id)

    def acceptOffer(self, transferId, destinationPath=None):
        current_file = self._client.userlist.currentUser.file
        local_path = current_file.get("path") if current_file else None
        if not local_path or not os.path.isfile(local_path):
            self._client._protocol.sendTransferDecision(transferId, False, reason="missing-local-path")
            return None
        fingerprint = fingerprint_file(local_path, current_file.get("name"), current_file.get("size"))
        session = self._sessions.get(transferId)
        if session:
            self._sessions[transferId] = session._replace(
                status="approved",
                destination_path=destinationPath,
                fingerprint=fingerprint,
                approved_local_path=local_path,
            )
        self._client._protocol.sendTransferDecision(transferId, True, fingerprint=fingerprint)
        return fingerprint

    def rejectOffer(self, transferId):
        self._client._protocol.sendTransferDecision(transferId, False, reason="rejected")

    def handleTicket(self, payload):
        transfer_id = payload["transferId"]
        session = self._sessions.get(transfer_id) or TransferClientSession(transfer_id=transfer_id)
        self._sessions[transfer_id] = session._replace(
            role=payload.get("role"),
            status="approved",
            ticket=payload,
            file=payload.get("file") or session.file,
            fingerprint=payload.get("fingerprint") or session.fingerprint,
            chunk_size=payload.get("chunkSize") or session.chunk_size,
        )
        self._open_ticket_socket(transfer_id)

    def prepareDownload(self, transferId, destinationPath):
        session = self._sessions.get(transferId) or TransferClientSession(transfer_id=transferId, role="receiver")
        directory = os.path.dirname(destinationPath)
        part_path = os.path.join(directory, ".syncplay-download.{}.part".format(transferId))
        self._sessions[transferId] = session._replace(
            destination_path=destinationPath,
            part_path=part_path,
            status="downloading",
        )
        return part_path

    def pauseTransfer(self, transferId):
        self._client._protocol.sendTransferPause(transferId, self._role_reason(transferId))
        self._update_status(transferId, "paused-local")

    def resumeTransfer(self, transferId):
        session = self._sessions.get(transferId)
        offset = 0
        if session and session.part_path and os.path.exists(session.part_path):
            offset = os.path.getsize(session.part_path)
        self._client._protocol.sendTransferResume(transferId, offset)
        self._update_status(transferId, "downloading")

    def cancelTransfer(self, transferId):
        self._client._protocol.sendTransferCancel(transferId, self._role_reason(transferId))
        self._update_status(transferId, "cancelled")

    def handleProgress(self, payload):
        session = self._sessions.get(payload["transferId"]) or TransferClientSession(transfer_id=payload["transferId"])
        bytes_transferred = payload.get("transferred", payload.get("bytesTransferred", session.bytes_transferred))
        self._sessions[payload["transferId"]] = session._replace(
            status=payload.get("status", "downloading"),
            bytes_transferred=bytes_transferred,
        )

    def handleError(self, payload):
        status = "failed"
        if payload.get("code") == "source-offline":
            status = "paused-source-offline"
        elif payload.get("code") == "source-changed-media":
            status = "paused-source-changed-media"
        session = self._sessions.get(payload["transferId"]) or TransferClientSession(transfer_id=payload["transferId"])
        self._sessions[payload["transferId"]] = session._replace(status=status)

    def _role_reason(self, transferId):
        session = self._sessions.get(transferId)
        return session.role if session and session.role else "receiver"

    def _update_status(self, transferId, status):
        session = self._sessions.get(transferId)
        if session:
            self._sessions[transferId] = session._replace(status=status)

    def _prompt_incoming_offer(self, transferId):
        session = self._sessions.get(transferId)
        prompt = getattr(getattr(self._client, "ui", None), "promptFileTransferOffer", None)
        if not session or not prompt:
            return
        answer = prompt(session)
        if answer is True:
            self.acceptOffer(transferId)
        elif answer is False:
            self.rejectOffer(transferId)

    def _open_ticket_socket(self, transferId):
        session = self._sessions.get(transferId)
        opener = getattr(self._client, "openTransferSocket", None)
        if not session or not session.ticket or not opener:
            return
        if session.role == "receiver" and not session.destination_path:
            destination_path = self._choose_download_destination(session)
            if not destination_path:
                self.cancelTransfer(transferId)
                return
            self.prepareDownload(transferId, destination_path)
            session = self._sessions.get(transferId)
        opener(session.ticket, TransferSocketClientProtocol(self, session.ticket, threaded_upload=self._threaded_upload))

    def _choose_download_destination(self, session):
        chooser = getattr(getattr(self._client, "ui", None), "chooseFileTransferDestination", None)
        if chooser:
            return chooser(session)
        if self._download_directory:
            filename = _safe_download_filename(_file_name(session.file) or session.transfer_id)
            return os.path.join(self._download_directory, filename)
        return None

    def streamUpload(self, transferId, transport, offset=0, chunkSize=None, schedule=None):
        session = self._sessions.get(transferId)
        if not session:
            raise ValueError("transfer session was not found")
        path = session.approved_local_path
        if not path or not os.path.isfile(path):
            raise ValueError("loaded file is not readable")
        chunk_size = int(chunkSize or session.chunk_size or 262144)
        position = int(offset or 0)
        size = os.path.getsize(path)
        if position < 0 or position > size:
            raise ValueError("upload offset is outside the file")

        def set_session(replacement):
            if schedule:
                schedule(lambda replacement=replacement: self._set_session(transferId, replacement))
            else:
                self._set_session(transferId, replacement)

        def write_frame(data):
            if schedule:
                schedule(lambda data=data: transport.write(data))
            else:
                transport.write(data)

        set_session(session._replace(status="uploading", bytes_transferred=position))
        with open(path, "rb") as handle:
            handle.seek(position)
            while True:
                chunk = handle.read(chunk_size)
                if not chunk:
                    break
                write_frame(encode_frame(TransferFrame(frame_type=FRAME_DATA, offset=position, payload=chunk)))
                position += len(chunk)
                current = self._sessions.get(transferId, session)
                set_session(current._replace(bytes_transferred=position))
        write_frame(encode_frame(TransferFrame(frame_type=FRAME_COMPLETE, offset=position, payload=b"")))
        current = self._sessions.get(transferId, session)
        set_session(current._replace(status="complete", bytes_transferred=position))
        return position

    def _set_session(self, transferId, session):
        self._sessions[transferId] = session

    def receiveFrame(self, transferId, frame):
        session = self._sessions.get(transferId)
        if not session:
            raise ValueError("transfer session was not found")
        if not session.part_path or not session.destination_path:
            raise ValueError("download destination is not prepared")
        if frame.frame_type == FRAME_DATA:
            return self._receiveDataFrame(transferId, session, frame)
        if frame.frame_type == FRAME_COMPLETE:
            return self._completeDownload(transferId, session, frame)
        return None

    def _receiveDataFrame(self, transferId, session, frame):
        current_size = os.path.getsize(session.part_path) if os.path.exists(session.part_path) else 0
        if int(frame.offset) != current_size:
            raise ValueError("unexpected transfer offset")
        with open(session.part_path, "ab") as handle:
            handle.write(frame.payload)
        transferred = current_size + len(frame.payload)
        self._sessions[transferId] = session._replace(status="downloading", bytes_transferred=transferred)
        return transferred

    def _completeDownload(self, transferId, session, frame):
        current_size = os.path.getsize(session.part_path) if os.path.exists(session.part_path) else 0
        if int(frame.offset) != current_size:
            raise ValueError("unexpected transfer offset")
        expected_size = _file_size(session.file)
        if expected_size is not None and current_size != expected_size:
            raise ValueError("download size does not match offer")
        if session.fingerprint:
            actual = fingerprint_file(session.part_path, _file_name(session.file), expected_size)
            if actual != session.fingerprint:
                raise ValueError("download fingerprint does not match offer")
        os.replace(session.part_path, session.destination_path)
        self._sessions[transferId] = session._replace(status="complete", bytes_transferred=current_size)
        return session.destination_path


def fingerprint_file(path, filename, size):
    digest = hashlib.sha256()
    file_size = size if size is not None else os.path.getsize(path)
    digest.update(str(filename or os.path.basename(path)).encode("utf-8"))
    digest.update(str(file_size).encode("utf-8"))
    with open(path, "rb") as handle:
        first = handle.read(1024 * 1024)
        digest.update(first)
        if file_size <= 2 * 1024 * 1024:
            digest.update(handle.read())
        else:
            handle.seek(-1024 * 1024, os.SEEK_END)
            digest.update(handle.read(1024 * 1024))
    return "sha256-first-last-size-v1:{}".format(digest.hexdigest())


def _file_name(file_):
    if isinstance(file_, dict):
        return file_.get("name")
    return getattr(file_, "name", None) if file_ else None


def _file_size(file_):
    size = file_.get("size") if isinstance(file_, dict) else getattr(file_, "size", None) if file_ else None
    if size is None:
        return None
    try:
        return int(size)
    except (TypeError, ValueError):
        return None


def _safe_download_filename(filename):
    filename = os.path.basename(str(filename or "syncplay-download"))
    return filename or "syncplay-download"


def _encode_transfer_connect(ticket, offset):
    payload = {
        "TransferConnect": {
            "transferId": ticket.get("transferId"),
            "token": ticket.get("token"),
            "role": ticket.get("role"),
            "offset": int(offset or 0),
        }
    }
    return (json.dumps(payload, separators=(",", ":")) + "\r\n").encode("utf-8")


class TransferSocketClientProtocol(Protocol):
    def __init__(self, transfers, ticket, threaded_upload=False):
        self._transfers = transfers
        self._ticket = ticket
        self._buffer = b""
        self._threaded_upload = threaded_upload

    def connectionMade(self, transport=None):
        if transport is not None:
            self.transport = transport
        offset = self._connection_offset()
        self.transport.write(_encode_transfer_connect(self._ticket, offset))
        if self._ticket.get("role") == "sender":
            if self._threaded_upload:
                reactor.callInThread(self._stream_upload, offset, reactor.callFromThread)
                return
            self._stream_upload(offset)

    def _stream_upload(self, offset, schedule=None):
        try:
            self._transfers.streamUpload(
                self._ticket.get("transferId"),
                self.transport,
                offset=offset,
                chunkSize=self._ticket.get("chunkSize"),
                schedule=schedule,
            )
        except (IOError, OSError, ValueError):
            if schedule:
                schedule(self.transport.loseConnection)
            else:
                self.transport.loseConnection()

    def dataReceived(self, data):
        self._buffer += data
        try:
            while self._buffer:
                frame, self._buffer = decode_frame(self._buffer)
                if frame is None:
                    return
                self._transfers.receiveFrame(self._ticket.get("transferId"), frame)
        except (TransferFrameError, ValueError):
            self.transport.loseConnection()

    def _connection_offset(self):
        session = self._transfers.get(self._ticket.get("transferId"))
        if self._ticket.get("role") == "receiver" and session and session.part_path and os.path.exists(session.part_path):
            return os.path.getsize(session.part_path)
        return int(self._ticket.get("offset") or 0)
