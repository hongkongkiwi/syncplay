# coding:utf8

import os

from syncplay.filetransfer_client import FileTransferClient, fingerprint_file
from syncplay.filetransfer_wire import FRAME_COMPLETE, FRAME_DATA, TransferFrame, decode_frame


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
    def __init__(self, file_=None, ui=None):
        self._protocol = Protocol()
        self.userlist = UserList(file_)
        self.ui = ui


class Ui(object):
    def __init__(self, result):
        self.result = result
        self.offers = []

    def promptFileTransferOffer(self, session):
        self.offers.append(session)
        return self.result


def test_request_download_from_user_sends_transfer_request():
    client = Client()
    transfers = FileTransferClient(client)

    transfers.requestDownload("Aki")

    assert client._protocol.calls == [("request", "Aki", 0)]


def test_incoming_offer_requires_approval():
    transfers = FileTransferClient(Client())

    transfers.handleOffer({"transferId": "tx1", "file": {"name": "movie.mkv", "size": 10}})

    assert transfers.get("tx1").status == "incoming-request"


def test_incoming_offer_can_be_approved_from_ui_prompt(tmp_path):
    path = tmp_path / "movie.mkv"
    path.write_bytes(b"movie")
    ui = Ui(True)
    client = Client({"name": "movie.mkv", "size": 5, "path": str(path)}, ui=ui)
    transfers = FileTransferClient(client)

    transfers.handleOffer({"transferId": "tx1", "source": "Aki", "file": {"name": "movie.mkv", "size": 5}})

    assert ui.offers[0].transfer_id == "tx1"
    assert client._protocol.calls[-1][0:4] == ("decision", "tx1", True, None)


def test_incoming_offer_can_be_rejected_from_ui_prompt():
    ui = Ui(False)
    client = Client({"name": "movie.mkv", "size": 5, "path": "/missing/movie.mkv"}, ui=ui)
    transfers = FileTransferClient(client)

    transfers.handleOffer({"transferId": "tx1", "source": "Aki", "file": {"name": "movie.mkv", "size": 5}})

    assert client._protocol.calls[-1] == ("decision", "tx1", False, "rejected", None, None)


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


def test_progress_updates_transferred_bytes_from_server_payload():
    transfers = FileTransferClient(Client())

    transfers.handleProgress({"transferId": "tx1", "transferred": 42, "status": "downloading"})

    assert transfers.get("tx1").bytes_transferred == 42


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


class Transport(object):
    def __init__(self):
        self.writes = []

    def write(self, data):
        self.writes.append(data)


def _decode_all(chunks):
    buffer = b"".join(chunks)
    frames = []
    while buffer:
        frame, buffer = decode_frame(buffer)
        if frame is None:
            break
        frames.append(frame)
    return frames


def test_sender_streams_loaded_file_as_data_frames(tmp_path):
    path = tmp_path / "movie.mkv"
    path.write_bytes(b"abcdef")
    client = Client({"name": "movie.mkv", "size": 6, "path": str(path)})
    transfers = FileTransferClient(client)
    transfers.handleOffer({"transferId": "tx1", "file": {"name": "movie.mkv", "size": 6}})
    transfers.acceptOffer("tx1")
    transport = Transport()

    transfers.streamUpload("tx1", transport, offset=2, chunkSize=2)

    frames = _decode_all(transport.writes)
    assert frames == [
        TransferFrame(frame_type=FRAME_DATA, offset=2, payload=b"cd"),
        TransferFrame(frame_type=FRAME_DATA, offset=4, payload=b"ef"),
        TransferFrame(frame_type=FRAME_COMPLETE, offset=6, payload=b""),
    ]
    assert transfers.get("tx1").bytes_transferred == 6
    assert transfers.get("tx1").status == "complete"


def test_receiver_writes_frames_to_part_file_and_renames_on_complete(tmp_path):
    final_path = tmp_path / "movie.mkv"
    expected_source = tmp_path / "source.mkv"
    expected_source.write_bytes(b"abcdef")
    client = Client()
    transfers = FileTransferClient(client)
    fingerprint = fingerprint_file(str(expected_source), "movie.mkv", 6)
    transfers.handleTicket({
        "transferId": "tx1",
        "role": "receiver",
        "offset": 0,
        "file": {"name": "movie.mkv", "size": 6},
        "fingerprint": fingerprint,
    })
    transfers.prepareDownload("tx1", str(final_path))

    transfers.receiveFrame("tx1", TransferFrame(frame_type=FRAME_DATA, offset=0, payload=b"abc"))
    transfers.receiveFrame("tx1", TransferFrame(frame_type=FRAME_DATA, offset=3, payload=b"def"))
    completed = transfers.receiveFrame("tx1", TransferFrame(frame_type=FRAME_COMPLETE, offset=6, payload=b""))

    assert completed == str(final_path)
    assert final_path.read_bytes() == b"abcdef"
    assert not os.path.exists(str(tmp_path / ".syncplay-download.tx1.part"))
    assert transfers.get("tx1").status == "complete"
    assert transfers.get("tx1").bytes_transferred == 6


def test_receiver_rejects_out_of_order_data_frame(tmp_path):
    client = Client()
    transfers = FileTransferClient(client)
    transfers.handleTicket({"transferId": "tx1", "role": "receiver", "file": {"name": "movie.mkv", "size": 6}})
    transfers.prepareDownload("tx1", str(tmp_path / "movie.mkv"))

    try:
        transfers.receiveFrame("tx1", TransferFrame(frame_type=FRAME_DATA, offset=3, payload=b"def"))
    except ValueError as error:
        assert "unexpected transfer offset" in str(error)
    else:
        raise AssertionError("expected offset validation to fail")
