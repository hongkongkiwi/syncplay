# coding:utf8

import os

import syncplay.filetransfer_client as filetransfer_client
from syncplay.filetransfer_client import FileTransferClient, fingerprint_file
from syncplay.filetransfer_wire import FRAME_COMPLETE, FRAME_CONTROL, FRAME_DATA, TransferFrame, decode_frame, encode_frame


class Protocol(object):
    def __init__(self):
        self.calls = []

    def sendTransferRequest(self, source, offset=0):
        self.calls.append(("request", source, offset))

    def sendTransferDecision(self, transferId, accepted, reason=None, fingerprint=None, chunkSize=None):
        self.calls.append(("decision", transferId, accepted, reason, fingerprint, chunkSize))

    def sendTransferPause(self, transferId, reason):
        self.calls.append(("pause", transferId, reason))

    def sendTransferResume(self, transferId, offset, fingerprint=None):
        self.calls.append(("resume", transferId, offset, fingerprint))

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
        self.transfer_socket_requests = []

    def openTransferSocket(self, ticket, handler):
        self.transfer_socket_requests.append((ticket, handler))


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


def test_sender_streams_approved_file_even_if_current_file_changes(tmp_path):
    approved = tmp_path / "approved.mkv"
    other = tmp_path / "other.mkv"
    approved.write_bytes(b"approved")
    other.write_bytes(b"other")
    client = Client({"name": "movie.mkv", "size": 8, "path": str(approved)})
    transfers = FileTransferClient(client)
    transfers.handleOffer({"transferId": "tx1", "file": {"name": "movie.mkv", "size": 8}})
    transfers.acceptOffer("tx1")
    client.userlist.currentUser.file = {"name": "movie.mkv", "size": 5, "path": str(other)}
    transport = Transport()

    transfers.streamUpload("tx1", transport, chunkSize=20)

    frames = _decode_all(transport.writes)
    assert frames[0] == TransferFrame(frame_type=FRAME_DATA, offset=0, payload=b"approved")


def test_fingerprint_covers_bytes_between_one_and_two_megabytes(tmp_path):
    first = tmp_path / "first.mkv"
    second = tmp_path / "second.mkv"
    data = bytearray(b"a" * (1024 * 1024 + 10))
    first.write_bytes(data)
    data[-1] = ord("b")
    second.write_bytes(data)

    assert fingerprint_file(str(first), "movie.mkv", len(data)) != fingerprint_file(str(second), "movie.mkv", len(data))


def test_download_writes_part_file_and_resume_uses_partial_size(tmp_path):
    client = Client()
    transfers = FileTransferClient(client)
    transfers.handleTicket({"transferId": "tx1", "role": "receiver", "offset": 0})

    part_path = transfers.prepareDownload("tx1", str(tmp_path / "movie.mkv"))
    with open(part_path, "wb") as part_file:
        part_file.write(b"partial")
    transfers.resumeTransfer("tx1")

    assert part_path.endswith(".syncplay-download.tx1.part")
    assert client._protocol.calls[-1] == ("resume", "tx1", 7, None)


def test_resume_sends_fingerprint_from_ticket(tmp_path):
    client = Client()
    transfers = FileTransferClient(client)
    transfers.handleTicket({"transferId": "tx1", "role": "receiver", "offset": 0, "fingerprint": "fp"})
    part_path = transfers.prepareDownload("tx1", str(tmp_path / "movie.mkv"))
    with open(part_path, "wb") as part_file:
        part_file.write(b"partial")

    transfers.resumeTransfer("tx1")

    assert client._protocol.calls[-1] == ("resume", "tx1", 7, "fp")


def test_receiver_ticket_prepares_destination_and_opens_transfer_socket(tmp_path):
    client = Client()
    transfers = FileTransferClient(client, download_directory=str(tmp_path))

    transfers.handleTicket({
        "transferId": "tx1",
        "role": "receiver",
        "token": "secret",
        "file": {"name": "movie.mkv", "size": 6},
    })

    session = transfers.get("tx1")
    assert session.destination_path == str(tmp_path / "movie.mkv")
    assert session.part_path == str(tmp_path / ".syncplay-download.tx1.part")
    assert client.transfer_socket_requests[0][0]["token"] == "secret"


def test_sender_ticket_opens_transfer_socket():
    client = Client({"name": "movie.mkv", "size": 6, "path": "/tmp/movie.mkv"})
    transfers = FileTransferClient(client)

    transfers.handleTicket({"transferId": "tx1", "role": "sender", "token": "secret", "offset": 2, "chunkSize": 2})

    assert client.transfer_socket_requests[0][0]["role"] == "sender"


def test_transfer_socket_handler_sends_handshake_and_uploads_for_sender(tmp_path):
    path = tmp_path / "movie.mkv"
    path.write_bytes(b"abcdef")
    client = Client({"name": "movie.mkv", "size": 6, "path": str(path)})
    transfers = FileTransferClient(client)
    transfers.handleOffer({"transferId": "tx1", "file": {"name": "movie.mkv", "size": 6}})
    transfers.acceptOffer("tx1")
    ticket = {"transferId": "tx1", "role": "sender", "token": "secret", "offset": 2, "chunkSize": 2}
    transfers.handleTicket(ticket)
    transport = Transport()

    client.transfer_socket_requests[0][1].connectionMade(transport)

    assert transport.writes[0] == b'{"TransferConnect":{"transferId":"tx1","token":"secret","role":"sender","offset":2}}\r\n'
    assert transport.writes[1:] == []
    client.transfer_socket_requests[0][1].dataReceived(transport_frame(FRAME_CONTROL, 0, b"ready"))
    frames = _decode_all(transport.writes[1:])
    assert frames[0] == TransferFrame(frame_type=FRAME_DATA, offset=2, payload=b"cd")


def test_transfer_socket_handler_can_upload_sender_from_thread(tmp_path, monkeypatch):
    class ImmediateReactor(object):
        def __init__(self):
            self.thread_calls = []
            self.scheduled = []

        def callInThread(self, fn, *args):
            self.thread_calls.append((fn, args))
            fn(*args)

        def callFromThread(self, fn, *args):
            self.scheduled.append((fn, args))
            fn(*args)

    path = tmp_path / "movie.mkv"
    path.write_bytes(b"abcdef")
    reactor = ImmediateReactor()
    monkeypatch.setattr(filetransfer_client, "reactor", reactor)
    client = Client({"name": "movie.mkv", "size": 6, "path": str(path)})
    transfers = FileTransferClient(client, threaded_upload=True)
    transfers.handleOffer({"transferId": "tx1", "file": {"name": "movie.mkv", "size": 6}})
    transfers.acceptOffer("tx1")
    transfers.handleTicket({"transferId": "tx1", "role": "sender", "token": "secret", "chunkSize": 3})
    transport = Transport()

    handler = client.transfer_socket_requests[0][1]
    handler.connectionMade(transport)
    handler.dataReceived(transport_frame(FRAME_CONTROL, 0, b"ready"))

    assert reactor.thread_calls
    assert reactor.scheduled
    assert _decode_all(transport.writes[1:])[-1] == TransferFrame(frame_type=FRAME_COMPLETE, offset=6, payload=b"")


def test_transfer_socket_handler_writes_receiver_frames(tmp_path):
    client = Client()
    transfers = FileTransferClient(client, download_directory=str(tmp_path))
    transfers.handleTicket({
        "transferId": "tx1",
        "role": "receiver",
        "token": "secret",
        "file": {"name": "movie.mkv", "size": 3},
    })
    handler = client.transfer_socket_requests[0][1]
    transport = Transport()

    handler.connectionMade(transport)
    handler.dataReceived(transport_frame(FRAME_DATA, 0, b"abc") + transport_frame(FRAME_COMPLETE, 3, b""))

    assert transport.writes == [b'{"TransferConnect":{"transferId":"tx1","token":"secret","role":"receiver","offset":0}}\r\n']
    assert (tmp_path / "movie.mkv").read_bytes() == b"abc"


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
        self.tls_options = None

    def write(self, data):
        self.writes.append(data)

    def startTLS(self, options):
        self.tls_options = options


def _decode_all(chunks):
    buffer = b"".join(chunks)
    frames = []
    while buffer:
        frame, buffer = decode_frame(buffer)
        if frame is None:
            break
        frames.append(frame)
    return frames


def transport_frame(frame_type, offset, payload):
    return encode_frame(TransferFrame(frame_type=frame_type, offset=offset, payload=payload))


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


def test_sender_stream_stops_without_complete_when_paused(tmp_path):
    path = tmp_path / "movie.mkv"
    path.write_bytes(b"abcdef")
    client = Client({"name": "movie.mkv", "size": 6, "path": str(path)})
    transfers = FileTransferClient(client)
    transfers.handleOffer({"transferId": "tx1", "file": {"name": "movie.mkv", "size": 6}})
    transfers.acceptOffer("tx1")
    transport = Transport()

    class PausingTransport(object):
        def write(self, data):
            transport.write(data)
            transfers.pauseTransfer("tx1")

    transfers.streamUpload("tx1", PausingTransport(), chunkSize=2)

    frames = _decode_all(transport.writes)
    assert frames == [TransferFrame(frame_type=FRAME_DATA, offset=0, payload=b"ab")]


def test_transfer_socket_starts_tls_before_transfer_connect(tmp_path):
    client = Client()
    transfers = FileTransferClient(client, download_directory=str(tmp_path))
    transfers.handleTicket({"transferId": "tx1", "role": "receiver", "token": "secret", "file": {"name": "movie.mkv", "size": 1}})
    handler = client.transfer_socket_requests[0][1]
    handler._tls_options = object()
    transport = Transport()

    handler.connectionMade(transport)
    handler.dataReceived(b'{"TLS":{"startTLS":"true"}}\r\n')

    assert transport.writes[0] == b'{"TLS":{"startTLS":"send"}}\r\n'
    assert transport.tls_options is handler._tls_options
    assert transport.writes[1] == b'{"TransferConnect":{"transferId":"tx1","token":"secret","role":"receiver","offset":0}}\r\n'


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
