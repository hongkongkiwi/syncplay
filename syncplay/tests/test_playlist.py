from syncplay import constants
from syncplay.client import SyncplayPlaylist
from syncplay.messages import getMessage


class UI:
    def __init__(self):
        self.errors = []
        self.playlists = []
        self.messages = []

    def showErrorMessage(self, message):
        self.errors.append(message)

    def setPlaylist(self, playlist, newIndexFilename=None):
        self.playlists.append((playlist, newIndexFilename))

    def showMessage(self, message):
        self.messages.append(message)


class CurrentUser:
    room = "room"


class Userlist:
    currentUser = CurrentUser()


class Client:
    def __init__(self):
        self.ui = UI()
        self.userlist = Userlist()
        self.playlistMayNeedRestoring = False

    def sharedPlaylistIsEnabled(self):
        return True


def test_remote_playlist_update_rejects_too_many_items():
    client = Client()
    playlist = SyncplayPlaylist(client)

    playlist.changePlaylist(["file.mkv"] * (constants.PLAYLIST_MAX_ITEMS + 1), username="remote")

    assert playlist._playlist == []
    assert client.ui.playlists == []
    assert client.ui.errors == [
        getMessage("playlist-too-many-items-error").format(constants.PLAYLIST_MAX_ITEMS)
    ]


def test_remote_playlist_update_rejects_invalid_payloads():
    client = Client()
    playlist = SyncplayPlaylist(client)

    playlist.changePlaylist(None, username="remote")
    playlist.changePlaylist(["valid.mkv", object()], username="remote")

    assert playlist._playlist == []
    assert client.ui.playlists == []
    assert client.ui.errors == [
        getMessage("playlist-invalid-error"),
        getMessage("playlist-invalid-error")
    ]


def test_remote_playlist_update_rejects_too_many_characters():
    client = Client()
    playlist = SyncplayPlaylist(client)

    playlist.changePlaylist(["x" * (constants.PLAYLIST_MAX_CHARACTERS + 1)], username="remote")

    assert playlist._playlist == []
    assert client.ui.playlists == []
    assert client.ui.errors == [
        getMessage("playlist-too-many-characters-error").format(constants.PLAYLIST_MAX_CHARACTERS)
    ]
