# coding:utf8

import pytest

from syncplay.filetransfer_wire import (
    FRAME_DATA,
    TransferFrame,
    TransferFrameError,
    TransferSocketRelay,
    decode_frame,
    encode_frame,
)


class Sink(object):
    def __init__(self):
        self.writes = []
        self.closed = False

    def write(self, data):
        self.writes.append(data)

    def loseConnection(self):
        self.closed = True


def test_encode_decode_data_frame():
    frame = TransferFrame(frame_type=FRAME_DATA, offset=12, payload=b"abc")

    decoded, remaining = decode_frame(encode_frame(frame))

    assert decoded == frame
    assert remaining == b""


def test_decode_keeps_incomplete_frame_buffered():
    encoded = encode_frame(TransferFrame(frame_type=FRAME_DATA, offset=0, payload=b"abc"))

    decoded, remaining = decode_frame(encoded[:10])

    assert decoded is None
    assert remaining == encoded[:10]


def test_decode_rejects_bad_magic():
    encoded = b"BAD!" + encode_frame(TransferFrame(frame_type=FRAME_DATA, offset=0, payload=b"abc"))[4:]

    with pytest.raises(TransferFrameError):
        decode_frame(encoded)


def test_decode_rejects_payload_larger_than_chunk_limit():
    encoded = encode_frame(TransferFrame(frame_type=FRAME_DATA, offset=0, payload=b"abcdef"))

    with pytest.raises(TransferFrameError):
        decode_frame(encoded, max_payload_size=3)


def test_relay_pairs_sender_and_receiver_by_valid_token():
    relay = TransferSocketRelay()
    sender = Sink()
    receiver = Sink()

    relay.register_token("sender-token", "tx1", "sender")
    relay.register_token("receiver-token", "tx1", "receiver")
    assert relay.connect("sender-token", sender) is None

    pair = relay.connect("receiver-token", receiver)

    assert pair.sender is sender
    assert pair.receiver is receiver


def test_relay_forwards_data_frame_from_sender_to_receiver():
    relay = TransferSocketRelay()
    sender = Sink()
    receiver = Sink()
    relay.register_token("sender-token", "tx1", "sender")
    relay.register_token("receiver-token", "tx1", "receiver")
    relay.connect("sender-token", sender)
    relay.connect("receiver-token", receiver)
    frame = TransferFrame(frame_type=FRAME_DATA, offset=0, payload=b"abc")

    relay.relay_frame("tx1", "sender", frame)

    assert receiver.writes == [encode_frame(frame)]


def test_relay_reports_data_progress_for_sender_frames():
    reports = []
    relay = TransferSocketRelay(progress_callback=lambda transfer_id, transferred: reports.append((transfer_id, transferred)))
    sender = Sink()
    receiver = Sink()
    relay.register_token("sender-token", "tx1", "sender")
    relay.register_token("receiver-token", "tx1", "receiver")
    relay.connect("sender-token", sender)
    relay.connect("receiver-token", receiver)

    relay.relay_frame("tx1", "sender", TransferFrame(frame_type=FRAME_DATA, offset=0, payload=b"abc"))
    relay.relay_frame("tx1", "sender", TransferFrame(frame_type=FRAME_DATA, offset=3, payload=b"de"))

    assert reports == [("tx1", 3), ("tx1", 5)]


def test_pause_stops_relay_without_losing_session():
    relay = TransferSocketRelay()
    sender = Sink()
    receiver = Sink()
    relay.register_token("sender-token", "tx1", "sender")
    relay.register_token("receiver-token", "tx1", "receiver")
    relay.connect("sender-token", sender)
    relay.connect("receiver-token", receiver)
    relay.pause("tx1")

    relay.relay_frame("tx1", "sender", TransferFrame(frame_type=FRAME_DATA, offset=0, payload=b"abc"))

    assert receiver.writes == []
    assert relay.get_pair("tx1") is not None


def test_socket_close_pauses_session():
    relay = TransferSocketRelay()
    sender = Sink()
    receiver = Sink()
    relay.register_token("sender-token", "tx1", "sender")
    relay.register_token("receiver-token", "tx1", "receiver")
    relay.connect("sender-token", sender)
    relay.connect("receiver-token", receiver)

    relay.disconnect("tx1", "sender")

    assert relay.get_pair("tx1").paused is True
