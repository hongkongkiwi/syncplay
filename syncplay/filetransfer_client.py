# coding:utf8

import hashlib
import os
from collections import namedtuple

from syncplay.filetransfer_wire import FRAME_COMPLETE, FRAME_DATA, TransferFrame, encode_frame


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
    ],
)
TransferClientSession.__new__.__defaults__ = (None, None, None, None, None, None, None, None, None, None, 0, None)


class FileTransferClient(object):
    def __init__(self, client):
        self._client = client
        self._sessions = {}

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

    def streamUpload(self, transferId, transport, offset=0, chunkSize=None):
        session = self._sessions.get(transferId)
        if not session:
            raise ValueError("transfer session was not found")
        current_file = self._client.userlist.currentUser.file
        path = current_file.get("path") if current_file else None
        if not path or not os.path.isfile(path):
            raise ValueError("loaded file is not readable")
        chunk_size = int(chunkSize or session.chunk_size or 262144)
        position = int(offset or 0)
        size = os.path.getsize(path)
        if position < 0 or position > size:
            raise ValueError("upload offset is outside the file")

        self._sessions[transferId] = session._replace(status="uploading", bytes_transferred=position)
        with open(path, "rb") as handle:
            handle.seek(position)
            while True:
                chunk = handle.read(chunk_size)
                if not chunk:
                    break
                transport.write(encode_frame(TransferFrame(frame_type=FRAME_DATA, offset=position, payload=chunk)))
                position += len(chunk)
                self._sessions[transferId] = self._sessions[transferId]._replace(bytes_transferred=position)
        transport.write(encode_frame(TransferFrame(frame_type=FRAME_COMPLETE, offset=position, payload=b"")))
        self._sessions[transferId] = self._sessions[transferId]._replace(status="complete", bytes_transferred=position)
        return position

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
    digest.update(str(filename or os.path.basename(path)).encode("utf-8"))
    digest.update(str(size if size is not None else os.path.getsize(path)).encode("utf-8"))
    with open(path, "rb") as handle:
        first = handle.read(1024 * 1024)
        digest.update(first)
        if os.path.getsize(path) > 2 * 1024 * 1024:
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
