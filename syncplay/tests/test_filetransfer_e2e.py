# coding:utf8

from syncplay.tests.test_filetransfer_server import Watcher, manager, media


def test_sender_approves_receiver_completes_pause_resume_and_cancel_flow():
    receiver = Watcher("receiver")
    source = Watcher("source", file_=media(size=1024))
    transfers = manager(watchers=[receiver, source])

    session = transfers.request_transfer(receiver, {"source": "source"})
    transfers.accept_transfer(source, session.transfer_id, fingerprint="fp")
    transfers.pause_transfer(receiver, session.transfer_id, "receiver")
    transfers.resume_transfer(receiver, session.transfer_id, offset=100, fingerprint="fp")
    transfers.cancel_transfer(receiver, session.transfer_id, "receiver")

    assert source.offers
    assert source.tickets
    assert receiver.tickets
    assert transfers.get_session(session.transfer_id) is None


def test_sender_disconnect_and_reconnect_failure_modes():
    receiver = Watcher("receiver")
    source = Watcher("source", file_=media())
    transfers = manager(watchers=[receiver, source])

    session = transfers.request_transfer(receiver, {"source": "source"})
    transfers.handle_watcher_left(source)

    assert transfers.get_session(session.transfer_id).status == "paused-source-offline"
    assert receiver.errors[-1]["code"] == "source-offline"


def test_sender_changes_media_mid_transfer():
    receiver = Watcher("receiver")
    source = Watcher("source", file_=media())
    transfers = manager(watchers=[receiver, source])

    session = transfers.request_transfer(receiver, {"source": "source"})
    source.setFile(media("other.mkv"))
    transfers.handle_watcher_file_changed(source)

    assert transfers.get_session(session.transfer_id).status == "paused-source-changed-media"
    assert receiver.errors[-1]["code"] == "source-changed-media"
