# coding:utf8

import pytest

from syncplay.filetransfer_wire import (
    FRAME_DATA,
    MAX_PAYLOAD_SIZE,
    TransferFrame,
    TransferFrameError,
    TransferToken,
    encode_frame,
)
import zlib
from syncplay.protocols import JSONCommandProtocol, SyncClientProtocol, SyncServerProtocol


class RoutingProtocol(JSONCommandProtocol):
    def __init__(self):
        self.handled = None
        self.error = None

    def handleTransfer(self, payload):
        self.handled = payload

    def dropWithError(self, error):
        self.error = error


class FakeUi(object):
    def showDebugMessage(self, line):
        pass


class FakeClient(object):
    def __init__(self):
        self.ui = FakeUi()
        self.transfers = []

    def handleTransfer(self, payload):
        self.transfers.append(payload)


class FakeFactory(object):
    def __init__(self):
        self.transfers = []

    def handleTransfer(self, watcher, payload):
        self.transfers.append((watcher, payload))


def capture_messages(protocol):
    sent = []
    protocol.sendMessage = sent.append
    return sent


def test_json_command_protocol_routes_transfer_messages():
    protocol = RoutingProtocol()

    protocol.handleMessages({"Transfer": {"progress": {"transferId": "abc"}}})

    assert protocol.handled == {"progress": {"transferId": "abc"}}
    assert protocol.error is None


def test_transfer_frame_encoder_rejects_oversized_payloads():
    with pytest.raises(TransferFrameError, match="transfer frame payload is too large"):
        encode_frame(
            TransferFrame(frame_type=FRAME_DATA, offset=0, payload=b"x" * (MAX_PAYLOAD_SIZE + 1))
        )


def test_json_command_protocol_rejects_transfer_connect_without_handler():
    protocol = RoutingProtocol()

    protocol.handleMessages({"TransferConnect": {"transferId": "abc"}})

    assert protocol.error


def test_client_protocol_can_send_transfer_request_without_file_metadata():
    protocol = SyncClientProtocol(FakeClient())
    sent = capture_messages(protocol)

    protocol.sendTransferRequest(" Aki ", offset=12)

    assert sent == [{"Transfer": {"request": {"source": "Aki", "offset": 12}}}]
    assert "file" not in sent[0]["Transfer"]["request"]
    assert "room" not in sent[0]["Transfer"]["request"]
    assert "receiver" not in sent[0]["Transfer"]["request"]


def test_client_protocol_can_send_transfer_decision_and_controls():
    protocol = SyncClientProtocol(FakeClient())
    sent = capture_messages(protocol)

    protocol.sendTransferDecision("tx1", True, fingerprint="fp", chunkSize=1024)
    protocol.sendTransferPause("tx1", "receiver")
    protocol.sendTransferResume("tx1", 4096, fingerprint="fp")
    protocol.sendTransferCancel("tx1", "receiver")

    assert sent == [
        {"Transfer": {"decision": {"transferId": "tx1", "accepted": True, "fingerprint": "fp", "chunkSize": 1024}}},
        {"Transfer": {"pause": {"transferId": "tx1", "reason": "receiver"}}},
        {"Transfer": {"resume": {"transferId": "tx1", "offset": 4096, "fingerprint": "fp"}}},
        {"Transfer": {"cancel": {"transferId": "tx1", "reason": "receiver"}}},
    ]


def test_client_protocol_forwards_transfer_messages_to_client():
    client = FakeClient()
    protocol = SyncClientProtocol(client)

    protocol.handleTransfer({"offer": {"transferId": "tx1"}})

    assert client.transfers == [{"offer": {"transferId": "tx1"}}]


def test_server_protocol_forwards_transfer_messages_to_factory():
    factory = FakeFactory()
    protocol = SyncServerProtocol(factory)
    protocol._watcher = object()
    protocol._logged = True

    protocol.handleTransfer({"request": {"source": "Aki", "offset": 0}})

    assert factory.transfers == [(protocol._watcher, {"request": {"source": "Aki", "offset": 0}})]


def test_server_protocol_can_send_transfer_offer_ticket_progress_and_error():
    protocol = SyncServerProtocol(FakeFactory())
    sent = capture_messages(protocol)

    protocol.sendTransferOffer({"transferId": "tx1"})
    protocol.sendTransferTicket({"transferId": "tx1", "token": "secret"})
    protocol.sendTransferProgress({"transferId": "tx1", "transferred": 5})
    protocol.sendTransferError("tx1", "source-left", "Source left.")

    assert sent == [
        {"Transfer": {"offer": {"transferId": "tx1"}}},
        {"Transfer": {"ticket": {"transferId": "tx1", "token": "secret"}}},
        {"Transfer": {"progress": {"transferId": "tx1", "transferred": 5}}},
        {"Transfer": {"error": {"transferId": "tx1", "code": "source-left", "message": "Source left."}}},
    ]


def test_server_protocol_accepts_transfer_connect_without_login():
    class Relay(object):
        def __init__(self):
            self.connected = []

        def connect(self, token, transport):
            self.connected.append((token, transport))
            return TransferToken("server-tx", "sender")

    factory = FakeFactory()
    factory.transferRelay = Relay()
    protocol = SyncServerProtocol(factory)
    protocol.transport = object()
    raw_mode = []
    protocol.setRawMode = lambda: raw_mode.append(True)

    protocol.handleMessages({"TransferConnect": {"transferId": "tx1", "token": "secret", "role": "receiver"}})

    assert factory.transferRelay.connected == [("secret", protocol.transport)]
    assert protocol._transferId == "server-tx"
    assert protocol._transferRole == "sender"
    assert raw_mode == [True]


def test_transfer_connection_lost_removes_logged_watcher_even_after_bad_transfer_connect():
    class Transport(object):
        def __init__(self):
            self.closed = False

        def loseConnection(self):
            self.closed = True

    watcher = object()
    factory = FakeFactory()
    factory.removed = []
    factory.removeWatcher = factory.removed.append
    factory.transferRelay = type("Relay", (), {"connect": lambda self, token, transport: None})()
    protocol = SyncServerProtocol(factory)
    protocol.transport = Transport()
    protocol._watcher = watcher
    protocol._logged = True

    protocol.handleTransferConnect({"transferId": "tx1", "token": "secret", "role": "receiver"})
    protocol.connectionLost(None)

    assert protocol.transport.closed is True
    assert factory.removed == [watcher]


def test_bad_transfer_connect_token_closes_socket_without_crashing():
    class Relay(object):
        def connect(self, token, transport):
            raise TransferFrameError("bad token")

    class Transport(object):
        def __init__(self):
            self.closed = False

        def loseConnection(self):
            self.closed = True

    factory = FakeFactory()
    factory.transferRelay = Relay()
    protocol = SyncServerProtocol(factory)
    protocol.transport = Transport()
    protocol.setRawMode = lambda: None

    protocol.handleTransferConnect({"transferId": "tx1", "token": "bad", "role": "receiver"})

    assert protocol.transport.closed is True


def test_bad_transfer_connect_payload_closes_socket_without_crashing():
    class Transport(object):
        def __init__(self):
            self.closed = False

        def loseConnection(self):
            self.closed = True

    factory = FakeFactory()
    factory.transferRelay = object()
    protocol = SyncServerProtocol(factory)
    protocol.transport = Transport()
    protocol.setRawMode = lambda: None

    protocol.handleTransferConnect("bad")

    assert protocol.transport.closed is True


def test_crc32_golden_values_for_js_cross_validation():
    """Verify Python zlib.crc32 output for known inputs.

    These values serve as a golden reference for the JavaScript manual CRC32
    implementation in react-native/src/syncplay/transferSocket.ts:headerCrc().
    Any discrepancy means the JS implementation is incorrect.
    """
    golden = [
        (b"", 0x00000000),
        (b"\x00\x00\x00\x00", 0x2144df1c),
        (b"SPFT", 0xf2f8e9c0),
        (b"\x00" * 20, 0x5a695d9f),
        (b"hello world", 0x0d4a1185),
        (b"\xff" * 20, 0xbe24f6e8),
        (b"\x00\x01\x02\x03\x04\x05\x06\x07\x08\x09\x0a\x0b\x0c\x0d\x0e\x0f\x10\x11\x12\x13", 0x6a046b80),
    ]
    for data, expected in golden:
        result = zlib.crc32(data) & 0xffffffff
        assert result == expected, (
            f"CRC32 mismatch for {data!r}: got 0x{result:08x}, expected 0x{expected:08x}"
        )
