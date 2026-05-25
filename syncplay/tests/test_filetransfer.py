# coding:utf8

import pytest

from syncplay.filetransfer import (
    TransferValidationError,
    is_shareable_loaded_file,
    normalize_transfer_filename,
    validate_transfer_request,
    validate_resume_offset,
)


def user(username, room):
    return {"username": username, "room": room}


_DEFAULT_PATH = object()


def loaded_file(name="Movie.mkv", size=1024, path=_DEFAULT_PATH):
    if path is _DEFAULT_PATH:
        path = "/media/Movie.mkv"
    return {
        "name": name,
        "duration": 60.0,
        "size": size,
        "path": path,
    }


def server_limits(max_size=2048):
    return {"maxSize": max_size}


def test_valid_transfer_request_returns_normalized_metadata():
    request = validate_transfer_request(
        user("sender", "room-a"),
        user("receiver", "room-a"),
        loaded_file("folder/Movie.mkv", 1024),
        server_limits(),
    )

    assert request.source == "sender"
    assert request.receiver == "receiver"
    assert request.room == "room-a"
    assert request.filename == "Movie.mkv"
    assert request.size == 1024
    assert request.local_path == "/media/Movie.mkv"


@pytest.mark.parametrize(
    "source, receiver",
    [
        (None, user("receiver", "room-a")),
        (user("sender", "room-a"), None),
        (user("", "room-a"), user("receiver", "room-a")),
        (user("sender", "room-a"), user("", "room-a")),
    ],
)
def test_transfer_request_requires_source_and_receiver(source, receiver):
    with pytest.raises(TransferValidationError):
        validate_transfer_request(source, receiver, loaded_file(), server_limits())


def test_transfer_request_requires_same_room():
    with pytest.raises(TransferValidationError):
        validate_transfer_request(
            user("sender", "room-a"),
            user("receiver", "room-b"),
            loaded_file(),
            server_limits(),
        )


@pytest.mark.parametrize(
    "filename",
    [
        "https://example.com/movie.mkv",
        "http://example.com/movie.mkv",
        "rtmp://example.com/live",
        "magnet:?xt=urn:btih:abc",
    ],
)
def test_stream_urls_are_not_shareable(filename):
    file_ = loaded_file(filename)

    assert is_shareable_loaded_file(file_) is False
    with pytest.raises(TransferValidationError):
        validate_transfer_request(
            user("sender", "room-a"),
            user("receiver", "room-a"),
            file_,
            server_limits(),
        )


def test_size_above_server_limit_fails():
    with pytest.raises(TransferValidationError):
        validate_transfer_request(
            user("sender", "room-a"),
            user("receiver", "room-a"),
            loaded_file(size=4096),
            server_limits(max_size=1024),
        )


@pytest.mark.parametrize(
    "file_",
    [
        loaded_file(".hidden.mkv"),
        loaded_file(path=""),
        loaded_file(path=None),
    ],
)
def test_hidden_names_and_missing_local_paths_are_not_shareable(file_):
    assert is_shareable_loaded_file(file_) is False
    with pytest.raises(TransferValidationError):
        validate_transfer_request(
            user("sender", "room-a"),
            user("receiver", "room-a"),
            file_,
            server_limits(),
        )


@pytest.mark.parametrize("max_size", ["bad", object()])
def test_invalid_server_limit_fails_with_validation_error(max_size):
    with pytest.raises(TransferValidationError):
        validate_transfer_request(
            user("sender", "room-a"),
            user("receiver", "room-a"),
            loaded_file(),
            server_limits(max_size=max_size),
        )


@pytest.mark.parametrize("offset", [-1, 1025])
def test_resume_offset_must_be_between_zero_and_file_size(offset):
    with pytest.raises(TransferValidationError):
        validate_resume_offset(offset, 1024)


@pytest.mark.parametrize("offset", [0, 1, 1024])
def test_resume_offset_accepts_offsets_inside_file_size(offset):
    assert validate_resume_offset(offset, 1024) == offset


@pytest.mark.parametrize(
    "name, expected",
    [
        ("folder/Movie.mkv", "Movie.mkv"),
        ("C:\\Movies\\Movie.mkv", "Movie.mkv"),
        ("  Movie.mkv  ", "Movie.mkv"),
        ("", None),
        (None, None),
    ],
)
def test_normalize_transfer_filename(name, expected):
    assert normalize_transfer_filename(name) == expected
