# coding:utf8

import pytest

from syncplay.filetransfer_wire import (
    FRAME_COMPLETE,
    FRAME_CONTROL,
    FRAME_DATA,
    TransferFrame,
    TransferFrameError,
    TransferSocketRelay,
    TransferToken,
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


class Clock(object):
    def __init__(self):
        self.now = 0
        self.calls = []

    def seconds(self):
        return self.now

    def callLater(self, delay, fn, *args):
        self.calls.append((delay, fn, args))
        return None

    def advance(self, seconds):
        self.now += seconds
        ready = self.calls
        self.calls = []
        for _, fn, args in ready:
            fn(*args)


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


def test_decode_rejects_unknown_frame_type():
    encoded = encode_frame(TransferFrame(frame_type=99, offset=0, payload=b"abc"))

    with pytest.raises(TransferFrameError):
        decode_frame(encoded)


def test_relay_pairs_sender_and_receiver_by_valid_token():
    relay = TransferSocketRelay()
    sender = Sink()
    receiver = Sink()

    relay.register_token("sender-token", "tx1", "sender")
    relay.register_token("receiver-token", "tx1", "receiver")
    assert relay.connect("sender-token", sender) == TransferToken("tx1", "sender")

    assert relay.connect("receiver-token", receiver) == TransferToken("tx1", "receiver")
    pair = relay.get_pair("tx1")

    assert pair.sender is sender
    assert pair.receiver is receiver
    assert sender.writes == [encode_frame(TransferFrame(frame_type=FRAME_CONTROL, offset=0, payload=b"ready"))]
    assert receiver.writes == sender.writes


def test_relay_forwards_data_frame_from_sender_to_receiver():
    relay = TransferSocketRelay()
    sender = Sink()
    receiver = Sink()
    relay.register_token("sender-token", "tx1", "sender")
    relay.register_token("receiver-token", "tx1", "receiver")
    relay.connect("sender-token", sender)
    relay.connect("receiver-token", receiver)
    receiver.writes = []
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
    receiver.writes = []

    relay.relay_frame("tx1", "sender", TransferFrame(frame_type=FRAME_DATA, offset=0, payload=b"abc"))
    relay.relay_frame("tx1", "sender", TransferFrame(frame_type=FRAME_DATA, offset=3, payload=b"de"))

    assert reports == [("tx1", 3), ("tx1", 5)]


def test_relay_throttles_sender_frames_when_rate_limit_is_set():
    clock = Clock()
    relay = TransferSocketRelay(rate_limit=2, clock=clock)
    sender = Sink()
    receiver = Sink()
    relay.register_token("sender-token", "tx1", "sender")
    relay.register_token("receiver-token", "tx1", "receiver")
    relay.connect("sender-token", sender)
    relay.connect("receiver-token", receiver)
    receiver.writes = []
    first = TransferFrame(frame_type=FRAME_DATA, offset=0, payload=b"ab")
    second = TransferFrame(frame_type=FRAME_DATA, offset=2, payload=b"cd")

    relay.relay_frame("tx1", "sender", first)
    relay.relay_frame("tx1", "sender", second)

    assert receiver.writes == [encode_frame(first)]
    assert clock.calls[0][0] == 1.0
    clock.advance(1.0)
    assert receiver.writes == [encode_frame(first), encode_frame(second)]


def test_relay_drops_scheduled_frame_after_pause():
    clock = Clock()
    relay = TransferSocketRelay(rate_limit=2, clock=clock)
    sender = Sink()
    receiver = Sink()
    relay.register_token("sender-token", "tx1", "sender")
    relay.register_token("receiver-token", "tx1", "receiver")
    relay.connect("sender-token", sender)
    relay.connect("receiver-token", receiver)
    receiver.writes = []

    relay.relay_frame("tx1", "sender", TransferFrame(frame_type=FRAME_DATA, offset=0, payload=b"ab"))
    relay.relay_frame("tx1", "sender", TransferFrame(frame_type=FRAME_DATA, offset=2, payload=b"cd"))
    relay.pause("tx1")
    clock.advance(1.0)

    assert len(receiver.writes) == 1


def test_pause_stops_relay_without_losing_session():
    relay = TransferSocketRelay()
    sender = Sink()
    receiver = Sink()
    relay.register_token("sender-token", "tx1", "sender")
    relay.register_token("receiver-token", "tx1", "receiver")
    relay.connect("sender-token", sender)
    relay.connect("receiver-token", receiver)
    receiver.writes = []
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
    receiver.writes = []

    relay.disconnect("tx1", "sender")

    assert relay.get_pair("tx1").paused is True


def test_complete_frame_cleans_relay_session():
    relay = TransferSocketRelay()
    sender = Sink()
    receiver = Sink()
    relay.register_token("sender-token", "tx1", "sender")
    relay.register_token("receiver-token", "tx1", "receiver")
    relay.connect("sender-token", sender)
    relay.connect("receiver-token", receiver)

    relay.relay_frame("tx1", "sender", TransferFrame(frame_type=FRAME_COMPLETE, offset=0, payload=b""))

    assert relay.get_pair("tx1") is None
