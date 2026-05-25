# coding:utf8

import ntpath
import posixpath
import re
from collections import namedtuple


class TransferValidationError(ValueError):
    pass


class TransferStatus(object):
    IDLE = "idle"
    REQUESTING = "requesting"
    WAITING_FOR_APPROVAL = "waiting-for-approval"
    APPROVED = "approved"
    DOWNLOADING = "downloading"
    PAUSED_LOCAL = "paused-local"
    PAUSED_SOURCE_OFFLINE = "paused-source-offline"
    PAUSED_SOURCE_CHANGED_MEDIA = "paused-source-changed-media"
    PAUSED_RECEIVER_OFFLINE = "paused-receiver-offline"
    VERIFYING = "verifying"
    COMPLETE = "complete"
    FAILED = "failed"
    CANCELLED = "cancelled"


class TransferRole(object):
    SENDER = "sender"
    RECEIVER = "receiver"


TransferRequest = namedtuple(
    "TransferRequest",
    ["source", "receiver", "room", "filename", "size", "local_path"],
)
TransferDecision = namedtuple(
    "TransferDecision",
    ["transfer_id", "accepted", "reason"],
)
TransferSession = namedtuple(
    "TransferSession",
    [
        "transfer_id",
        "source",
        "receiver",
        "room",
        "filename",
        "duration",
        "size",
        "chunk_size",
        "offset",
        "fingerprint",
        "status",
    ],
)


_STREAM_PREFIXES = (
    "http://",
    "https://",
    "rtmp://",
    "rtsp://",
    "magnet:",
)

_HASH_BASENAME_RE = re.compile(r"^[0-9a-f]{32,}(?:\.[a-z0-9]{1,8})?$", re.IGNORECASE)


def _read_value(container, key):
    if container is None:
        return None
    if isinstance(container, dict):
        return container.get(key)
    return getattr(container, key, None)


def _read_room(user):
    room = _read_value(user, "room")
    if isinstance(room, dict):
        return room.get("name")
    return room


def normalize_transfer_filename(name):
    if not name:
        return None
    name = str(name).strip()
    if not name:
        return None
    return ntpath.basename(posixpath.basename(name))


def get_transfer_local_path(file_):
    path = (
        _read_value(file_, "path")
        or _read_value(file_, "localPath")
        or _read_value(file_, "uri")
    )
    if not path:
        return None
    path = str(path).strip()
    return path or None


def _is_stream_url(value):
    return bool(value and str(value).strip().lower().startswith(_STREAM_PREFIXES))


def _is_hash_filename(filename):
    return bool(filename and _HASH_BASENAME_RE.match(filename))


def is_shareable_loaded_file(file_):
    filename = _read_value(file_, "name")
    size = _read_value(file_, "size")
    normalized = normalize_transfer_filename(filename)
    if not normalized:
        return False
    if normalized.startswith("."):
        return False
    if _is_hash_filename(normalized):
        return False
    if _is_stream_url(filename):
        return False
    local_path = get_transfer_local_path(file_)
    if not local_path or _is_stream_url(local_path):
        return False
    if size is None:
        return False
    try:
        return int(size) >= 0
    except (TypeError, ValueError):
        return False


def validate_resume_offset(offset, file_size):
    try:
        offset = int(offset)
        file_size = int(file_size)
    except (TypeError, ValueError):
        raise TransferValidationError("resume offset and file size must be integers")
    if offset < 0 or offset > file_size:
        raise TransferValidationError("resume offset must be between 0 and file size")
    return offset


def validate_transfer_request(source, receiver, file_, server_limits):
    source_name = _read_value(source, "username")
    receiver_name = _read_value(receiver, "username")
    source_room = _read_room(source)
    receiver_room = _read_room(receiver)

    if not source_name or not receiver_name:
        raise TransferValidationError("source and receiver are required")
    if not source_room or not receiver_room or source_room != receiver_room:
        raise TransferValidationError("source and receiver must be in the same room")
    if not is_shareable_loaded_file(file_):
        raise TransferValidationError("loaded file is not shareable")

    try:
        size = int(_read_value(file_, "size"))
    except (TypeError, ValueError):
        raise TransferValidationError("file size must be an integer")
    max_size = _read_value(server_limits, "maxSize")
    if max_size is not None:
        try:
            max_size = int(max_size)
        except (TypeError, ValueError):
            raise TransferValidationError("server transfer limit must be an integer")
        if size > max_size:
            raise TransferValidationError("file is larger than the server transfer limit")

    return TransferRequest(
        source=source_name,
        receiver=receiver_name,
        room=source_room,
        filename=normalize_transfer_filename(_read_value(file_, "name")),
        size=size,
        local_path=get_transfer_local_path(file_),
    )
