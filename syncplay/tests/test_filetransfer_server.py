# coding:utf8

import pytest

from syncplay.filetransfer_server import TransferManager, TransferServerConfig
from syncplay.server import SyncFactory


class Room(object):
    def __init__(self, name):
        self._name = name

    def getName(self):
        return self._name


class Watcher(object):
    def __init__(self, name, room="room", file_=None):
        self._name = name
        self._room = Room(room) if room else None
        self._file = file_
        self.offers = []
        self.tickets = []
        self.errors = []
        self.progress = []

    def getName(self):
        return self._name

    def getRoom(self):
        return self._room

    def getFile(self):
        return self._file

    def setFile(self, file_):
        self._file = file_

    def sendTransferOffer(self, payload):
        self.offers.append(payload)

    def sendTransferTicket(self, payload):
        self.tickets.append(payload)

    def sendTransferError(self, transferId, code, message):
        self.errors.append({"transferId": transferId, "code": code, "message": message})

    def sendTransferProgress(self, payload):
        self.progress.append(payload)


def media(name="movie.mkv", size=1024):
    return {"name": name, "duration": 60.0, "size": size}


def manager(enabled=True, watchers=None):
    return TransferManager(TransferServerConfig(enabled=enabled), watchers or [])


def test_request_rejected_when_server_feature_disabled():
    receiver = Watcher("receiver")
    source = Watcher("source", file_=media())
    transfers = manager(enabled=False, watchers=[receiver, source])

    transfers.request_transfer(receiver, {"source": "source", "file": {"name": "fake.mkv", "size": 1}})

    assert receiver.errors[0]["code"] == "file-transfer-disabled"
    assert source.offers == []


def test_request_uses_server_side_source_file_metadata():
    receiver = Watcher("receiver")
    source = Watcher("source", file_=media("real.mkv", 2048))
    transfers = TransferManager(TransferServerConfig(enabled=True, max_per_user=2), [receiver, source])

    session = transfers.request_transfer(
        receiver,
        {
            "source": "source",
            "receiver": "spoofed",
            "room": "wrong",
            "file": {"name": "fake.mkv", "size": 1},
        },
    )

    assert session.receiver == "receiver"
    assert session.room == "room"
    assert session.filename == "real.mkv"
    assert session.size == 2048
    assert source.offers[0]["file"]["name"] == "real.mkv"


def test_request_ignores_client_supplied_transfer_id():
    receiver = Watcher("receiver")
    source = Watcher("source", file_=media())
    transfers = TransferManager(TransferServerConfig(enabled=True, max_per_user=2), [receiver, source])

    first = transfers.request_transfer(receiver, {"source": "source", "transferId": "client-id"})
    second = transfers.request_transfer(receiver, {"source": "source", "transferId": first.transfer_id})

    assert first.transfer_id != "client-id"
    assert second.transfer_id != first.transfer_id
    assert transfers.get_session(first.transfer_id) is first
    assert transfers.get_session(second.transfer_id) is second


def test_request_rejected_if_source_and_receiver_are_not_in_same_room():
    receiver = Watcher("receiver", room="room-a")
    source = Watcher("source", room="room-b", file_=media())
    transfers = manager(watchers=[receiver, source])

    transfers.request_transfer(receiver, {"source": "source"})

    assert receiver.errors[0]["code"] == "not-same-room"
    assert source.offers == []


def test_accept_sends_transfer_tickets_to_both_clients():
    receiver = Watcher("receiver")
    source = Watcher("source", file_=media())
    transfers = manager(watchers=[receiver, source])
    session = transfers.request_transfer(receiver, {"source": "source"})

    transfers.accept_transfer(source, session.transfer_id, fingerprint="fp")

    assert source.tickets[0]["role"] == "sender"
    assert receiver.tickets[0]["role"] == "receiver"
    assert source.tickets[0]["transferId"] == session.transfer_id
    assert source.tickets[0]["token"] != receiver.tickets[0]["token"]
    assert receiver.tickets[0]["file"] == {"name": "movie.mkv", "duration": 60.0, "size": 1024}
    assert receiver.tickets[0]["fingerprint"] == "fp"


def test_progress_is_sent_to_both_transfer_participants():
    receiver = Watcher("receiver")
    source = Watcher("source", file_=media())
    transfers = manager(watchers=[receiver, source])
    session = transfers.request_transfer(receiver, {"source": "source"})
    transfers.accept_transfer(source, session.transfer_id, fingerprint="fp")

    transfers.report_progress(session.transfer_id, 512)

    assert source.progress[-1] == {
        "transferId": session.transfer_id,
        "transferred": 512,
        "size": 1024,
        "status": "downloading",
    }
    assert receiver.progress[-1] == source.progress[-1]


def test_complete_progress_removes_session_from_active_map():
    receiver = Watcher("receiver")
    source = Watcher("source", file_=media())
    transfers = manager(watchers=[receiver, source])
    session = transfers.request_transfer(receiver, {"source": "source"})
    transfers.accept_transfer(source, session.transfer_id, fingerprint="fp")

    transfers.report_progress(session.transfer_id, 1024)

    assert receiver.progress[-1]["status"] == "complete"
    assert transfers.get_session(session.transfer_id) is None


def test_cancel_notifies_both_sides_and_removes_session():
    receiver = Watcher("receiver")
    source = Watcher("source", file_=media())
    transfers = manager(watchers=[receiver, source])
    session = transfers.request_transfer(receiver, {"source": "source"})

    transfers.cancel_transfer(receiver, session.transfer_id, "receiver")

    assert source.errors[0]["code"] == "cancelled"
    assert receiver.errors[0]["code"] == "cancelled"
    assert transfers.get_session(session.transfer_id) is None


def test_cancel_rejects_non_participants():
    receiver = Watcher("receiver")
    source = Watcher("source", file_=media())
    stranger = Watcher("stranger")
    transfers = manager(watchers=[receiver, source, stranger])
    session = transfers.request_transfer(receiver, {"source": "source"})

    transfers.cancel_transfer(stranger, session.transfer_id, "stranger")

    assert stranger.errors[-1]["code"] == "not-participant"
    assert transfers.get_session(session.transfer_id) is session


@pytest.mark.parametrize(
    "handler, code",
    [
        ("handle_watcher_left", "source-offline"),
        ("handle_watcher_file_changed", "source-changed-media"),
    ],
)
def test_source_leaving_or_changing_media_pauses_session(handler, code):
    receiver = Watcher("receiver")
    source = Watcher("source", file_=media())
    transfers = manager(watchers=[receiver, source])
    session = transfers.request_transfer(receiver, {"source": "source"})

    getattr(transfers, handler)(source)

    assert transfers.get_session(session.transfer_id).status.startswith("paused")
    assert receiver.errors[0]["code"] == code


def test_resume_rejects_changed_fingerprint_or_size():
    receiver = Watcher("receiver")
    source = Watcher("source", file_=media(size=1024))
    transfers = manager(watchers=[receiver, source])
    session = transfers.request_transfer(receiver, {"source": "source"})
    transfers.accept_transfer(source, session.transfer_id, fingerprint="fp")

    source.setFile(media(size=2048))
    transfers.resume_transfer(receiver, session.transfer_id, offset=10, fingerprint="wrong")

    assert receiver.errors[-1]["code"] == "source-changed-media"


def test_malformed_request_and_resume_offsets_return_errors():
    receiver = Watcher("receiver")
    source = Watcher("source", file_=media(size=1024))
    transfers = manager(watchers=[receiver, source])

    assert transfers.request_transfer(receiver, {"source": "source", "offset": "bad"}) is None
    assert receiver.errors[-1]["code"] == "bad-offset"


def test_transfer_limits_reject_excess_active_or_user_sessions():
    receiver = Watcher("receiver")
    other_receiver = Watcher("other")
    source = Watcher("source", file_=media())
    transfers = TransferManager(
        TransferServerConfig(enabled=True, max_active=1, max_per_user=1),
        [receiver, other_receiver, source],
    )

    transfers.request_transfer(receiver, {"source": "source"})
    transfers.request_transfer(other_receiver, {"source": "source"})

    assert other_receiver.errors[-1]["code"] == "too-many-active-transfers"


def test_transfer_limit_allows_new_session_after_completion():
    receiver = Watcher("receiver")
    other_receiver = Watcher("other")
    source = Watcher("source", file_=media())
    transfers = TransferManager(
        TransferServerConfig(enabled=True, max_active=1, max_per_user=2),
        [receiver, other_receiver, source],
    )
    session = transfers.request_transfer(receiver, {"source": "source"})
    transfers.accept_transfer(source, session.transfer_id, fingerprint="fp")
    transfers.report_progress(session.transfer_id, session.size)

    replacement = transfers.request_transfer(other_receiver, {"source": "source"})

    assert replacement is not None
    assert replacement.transfer_id != session.transfer_id
    assert transfers.get_session(session.transfer_id) is None


def test_transfer_limit_rejects_per_user_overflow_when_global_limit_allows_more():
    receiver = Watcher("receiver")
    other_receiver = Watcher("other")
    source = Watcher("source", file_=media())
    transfers = TransferManager(
        TransferServerConfig(enabled=True, max_active=4, max_per_user=1),
        [receiver, other_receiver, source],
    )

    transfers.request_transfer(receiver, {"source": "source"})
    transfers.request_transfer(other_receiver, {"source": "source"})

    assert other_receiver.errors[-1]["code"] == "too-many-user-transfers"


def test_cleanup_expired_sessions_removes_tokens_and_session():
    now = [1000]
    receiver = Watcher("receiver")
    source = Watcher("source", file_=media())
    transfers = TransferManager(
        TransferServerConfig(enabled=True, token_ttl=10),
        [receiver, source],
        now=lambda: now[0],
    )
    session = transfers.request_transfer(receiver, {"source": "source"})
    transfers.accept_transfer(source, session.transfer_id, fingerprint="fp")
    now[0] = 1011

    transfers.cleanup_expired_sessions()

    assert transfers.get_session(session.transfer_id) is None

    session = transfers.request_transfer(receiver, {"source": "source"})
    transfers.accept_transfer(source, session.transfer_id, fingerprint="fp")
    transfers.resume_transfer(receiver, session.transfer_id, offset="bad", fingerprint="fp")

    assert receiver.errors[-1]["code"] == "bad-offset"


def test_factory_pause_and_resume_updates_transfer_relay():
    class Relay(object):
        def __init__(self):
            self.paused = []
            self.resumed = []

        def pause(self, transfer_id):
            self.paused.append(transfer_id)

        def resume(self, transfer_id):
            self.resumed.append(transfer_id)

    receiver = Watcher("receiver")
    source = Watcher("source", file_=media())
    transfers = manager(watchers=[receiver, source])
    session = transfers.request_transfer(receiver, {"source": "source"})
    transfers.accept_transfer(source, session.transfer_id, fingerprint="fp")
    factory = type("Factory", (), {})()
    factory.fileTransfers = transfers
    factory.transferRelay = Relay()

    SyncFactory.handleTransfer(factory, receiver, {"pause": {"transferId": session.transfer_id, "reason": "receiver"}})
    SyncFactory.handleTransfer(factory, receiver, {"resume": {"transferId": session.transfer_id, "offset": 0, "fingerprint": "fp"}})

    assert factory.transferRelay.paused == [session.transfer_id]
    assert factory.transferRelay.resumed == [session.transfer_id]
