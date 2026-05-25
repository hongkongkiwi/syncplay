# coding:utf8

import hashlib
import os
from collections import namedtuple


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
    ],
)
TransferClientSession.__new__.__defaults__ = (None, None, None, None, None, None, None, None, None, None)


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
        self._sessions[payload["transferId"]] = session._replace(status=payload.get("status", "downloading"))

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
