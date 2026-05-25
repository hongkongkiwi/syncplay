# coding:utf8

import os

from syncplay.filetransfer_client import FileTransferClient


class Protocol(object):
    def __init__(self):
        self.calls = []

    def sendTransferRequest(self, source, offset=0):
        self.calls.append(("request", source, offset))

    def sendTransferDecision(self, transferId, accepted, reason=None, fingerprint=None, chunkSize=None):
        self.calls.append(("decision", transferId, accepted, reason, fingerprint, chunkSize))

    def sendTransferPause(self, transferId, reason):
        self.calls.append(("pause", transferId, reason))

    def sendTransferResume(self, transferId, offset):
        self.calls.append(("resume", transferId, offset))

    def sendTransferCancel(self, transferId, reason):
        self.calls.append(("cancel", transferId, reason))


class User(object):
    def __init__(self, file_=None):
        self.file = file_


class UserList(object):
    def __init__(self, file_=None):
        self.currentUser = User(file_)


class Client(object):
    def __init__(self, file_=None):
        self._protocol = Protocol()
        self.userlist = UserList(file_)


def test_request_download_from_user_sends_transfer_request():
    client = Client()
    transfers = FileTransferClient(client)

    transfers.requestDownload("Aki")

    assert client._protocol.calls == [("request", "Aki", 0)]


def test_incoming_offer_requires_approval():
    transfers = FileTransferClient(Client())

    transfers.handleOffer({"transferId": "tx1", "file": {"name": "movie.mkv", "size": 10}})

    assert transfers.get("tx1").status == "incoming-request"


def test_accept_offer_refuses_missing_current_file_path():
    client = Client({"name": "movie.mkv", "size": 10})
    transfers = FileTransferClient(client)
    transfers.handleOffer({"transferId": "tx1", "file": {"name": "movie.mkv", "size": 10}})

    transfers.acceptOffer("tx1", "/tmp/movie.mkv")

    assert client._protocol.calls[-1][0:4] == ("decision", "tx1", False, "missing-local-path")


def test_accept_offer_sends_fingerprint_for_current_file(tmp_path):
    path = tmp_path / "movie.mkv"
    path.write_bytes(b"movie")
    client = Client({"name": "movie.mkv", "size": 5, "path": str(path)})
    transfers = FileTransferClient(client)
    transfers.handleOffer({"transferId": "tx1", "file": {"name": "movie.mkv", "size": 5}})

    transfers.acceptOffer("tx1", str(tmp_path / "download.mkv"))

    assert client._protocol.calls[-1][0:4] == ("decision", "tx1", True, None)
    assert client._protocol.calls[-1][4].startswith("sha256-first-last-size-v1:")


def test_download_writes_part_file_and_resume_uses_partial_size(tmp_path):
    client = Client()
    transfers = FileTransferClient(client)
    transfers.handleTicket({"transferId": "tx1", "role": "receiver", "offset": 0})

    part_path = transfers.prepareDownload("tx1", str(tmp_path / "movie.mkv"))
    with open(part_path, "wb") as part_file:
        part_file.write(b"partial")
    transfers.resumeTransfer("tx1")

    assert part_path.endswith(".syncplay-download.tx1.part")
    assert client._protocol.calls[-1] == ("resume", "tx1", 7)


def test_cancel_keeps_completed_file(tmp_path):
    completed = tmp_path / "movie.mkv"
    completed.write_bytes(b"done")
    client = Client()
    transfers = FileTransferClient(client)
    transfers.handleTicket({"transferId": "tx1", "role": "receiver", "offset": 0})
    transfers.prepareDownload("tx1", str(completed))

    transfers.cancelTransfer("tx1")

    assert os.path.exists(str(completed))
    assert client._protocol.calls[-1] == ("cancel", "tx1", "receiver")
