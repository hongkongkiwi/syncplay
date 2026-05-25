# coding:utf8

import struct
import time
import zlib
from collections import namedtuple


FRAME_DATA = 1
FRAME_CONTROL = 2
FRAME_COMPLETE = 3

MAGIC = b"SPFT"
VERSION = 1
HEADER_LENGTH = 24
_HEADER_WITHOUT_CRC = struct.Struct("!4sHHQI")
_HEADER = struct.Struct("!4sHHQII")


class TransferFrameError(ValueError):
    pass


TransferFrame = namedtuple("TransferFrame", ["frame_type", "offset", "payload"])
TransferPair = namedtuple("TransferPair", ["transfer_id", "sender", "receiver", "paused"])
TransferToken = namedtuple("TransferToken", ["transfer_id", "role"])


def encode_frame(frame):
    payload = frame.payload or b""
    header_without_crc = _HEADER_WITHOUT_CRC.pack(
        MAGIC,
        VERSION,
        int(frame.frame_type),
        int(frame.offset),
        len(payload),
    )
    header_crc = zlib.crc32(header_without_crc) & 0xffffffff
    return header_without_crc + struct.pack("!I", header_crc) + payload


def decode_frame(buffer, max_payload_size=262144):
    if len(buffer) < HEADER_LENGTH:
        return None, buffer

    magic, version, frame_type, offset, payload_length, header_crc = _HEADER.unpack(buffer[:HEADER_LENGTH])
    if magic != MAGIC:
        raise TransferFrameError("bad transfer frame magic")
    if version != VERSION:
        raise TransferFrameError("unsupported transfer frame version")
    if frame_type not in (FRAME_DATA, FRAME_CONTROL, FRAME_COMPLETE):
        raise TransferFrameError("unsupported transfer frame type")
    if payload_length > max_payload_size:
        raise TransferFrameError("transfer frame payload is too large")

    expected_crc = zlib.crc32(buffer[:HEADER_LENGTH - 4]) & 0xffffffff
    if header_crc != expected_crc:
        raise TransferFrameError("bad transfer frame header crc")

    frame_length = HEADER_LENGTH + payload_length
    if len(buffer) < frame_length:
        return None, buffer

    payload = buffer[HEADER_LENGTH:frame_length]
    remaining = buffer[frame_length:]
    return TransferFrame(frame_type=frame_type, offset=offset, payload=payload), remaining


class TransferSocketRelay(object):
    def __init__(self, progress_callback=None, rate_limit=None, clock=None):
        self._tokens = {}
        self._pairs = {}
        self._progress = {}
        self._progress_callback = progress_callback
        self._rate_limit = int(rate_limit) if rate_limit else None
        self._clock = clock
        self._send_after = {}

    def register_token(self, token, transfer_id, role):
        self._tokens[token] = TransferToken(transfer_id=transfer_id, role=role)

    def connect(self, token, transport):
        ticket = self._tokens.pop(token, None)
        if not ticket:
            raise TransferFrameError("invalid transfer token")

        pair = self._pairs.get(ticket.transfer_id)
        if not pair:
            pair = TransferPair(ticket.transfer_id, None, None, False)

        if ticket.role == "sender":
            pair = pair._replace(sender=transport)
        elif ticket.role == "receiver":
            pair = pair._replace(receiver=transport)
        else:
            raise TransferFrameError("invalid transfer role")

        self._pairs[ticket.transfer_id] = pair
        if pair.sender and pair.receiver:
            ready = encode_frame(TransferFrame(frame_type=FRAME_CONTROL, offset=0, payload=b"ready"))
            pair.sender.write(ready)
            pair.receiver.write(ready)
        return ticket

    def get_pair(self, transfer_id):
        return self._pairs.get(transfer_id)

    def relay_frame(self, transfer_id, role, frame):
        pair = self._pairs.get(transfer_id)
        if not pair or pair.paused:
            return
        if role == "sender":
            target = pair.receiver
        elif role == "receiver":
            target = pair.sender
        else:
            raise TransferFrameError("invalid transfer role")
        if target:
            self._write_or_throttle(transfer_id, role, target, frame)

    def pause(self, transfer_id, close=False):
        pair = self._pairs.get(transfer_id)
        if pair:
            if close:
                for transport in (pair.sender, pair.receiver):
                    if transport and hasattr(transport, "loseConnection"):
                        transport.loseConnection()
                self._cleanup(transfer_id)
                return
            self._pairs[transfer_id] = pair._replace(paused=True)

    def resume(self, transfer_id):
        pair = self._pairs.get(transfer_id)
        if pair:
            self._pairs[transfer_id] = pair._replace(paused=False)

    def disconnect(self, transfer_id, role):
        pair = self._pairs.get(transfer_id)
        if not pair:
            return
        if role == "sender":
            pair = pair._replace(sender=None, paused=True)
        elif role == "receiver":
            pair = pair._replace(receiver=None, paused=True)
        if not pair.sender and not pair.receiver:
            self._cleanup(transfer_id)
            return
        self._pairs[transfer_id] = pair

    def _cleanup(self, transfer_id):
        self._pairs.pop(transfer_id, None)
        self._progress.pop(transfer_id, None)
        self._send_after.pop(transfer_id, None)

    def _write_or_throttle(self, transfer_id, role, target, frame):
        encoded = encode_frame(frame)
        if role != "sender" or not self._rate_limit or self._rate_limit <= 0:
            self._write_frame(transfer_id, role, target, frame, encoded)
            return

        now = self._seconds()
        send_at = max(now, self._send_after.get(transfer_id, now))
        delay = send_at - now
        if frame.frame_type == FRAME_DATA:
            send_at += float(len(frame.payload or b"")) / float(self._rate_limit)
        self._send_after[transfer_id] = send_at
        if delay > 0 and self._clock:
            self._clock.callLater(delay, self._write_frame, transfer_id, role, target, frame, encoded)
        else:
            self._write_frame(transfer_id, role, target, frame, encoded)

    def _write_frame(self, transfer_id, role, target, frame, encoded):
        pair = self._pairs.get(transfer_id)
        if not pair or pair.paused:
            return
        expected = pair.receiver if role == "sender" else pair.sender
        if expected is not target:
            return
        target.write(encoded)
        if role == "sender" and frame.frame_type == FRAME_DATA:
            transferred = max(self._progress.get(transfer_id, 0), int(frame.offset) + len(frame.payload or b""))
            self._progress[transfer_id] = transferred
            if self._progress_callback:
                self._progress_callback(transfer_id, transferred)
        if role == "sender" and frame.frame_type == FRAME_COMPLETE:
            self._cleanup(transfer_id)

    def _seconds(self):
        if self._clock and hasattr(self._clock, "seconds"):
            return self._clock.seconds()
        return time.time()
