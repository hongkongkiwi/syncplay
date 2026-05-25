# coding:utf8

from syncplay import constants
from syncplay.server import SyncFactory


def test_file_transfer_defaults_disabled():
    factory = SyncFactory()

    assert factory.getFeatures()["fileTransfer"] is False


def test_file_transfer_feature_advertises_limits_when_enabled():
    factory = SyncFactory(
        enableFileTransfers=True,
        fileTransferMaxSize=1234,
        fileTransferMaxActive=2,
        fileTransferMaxPerUser=1,
        fileTransferRateLimit=99,
        fileTransferTokenTtl=30,
    )

    features = factory.getFeatures()

    assert features["fileTransfer"] is True
    assert features["fileTransferVersion"] == 1
    assert features["fileTransferMaxSize"] == 1234
    assert features["fileTransferChunkSize"] == constants.FILE_TRANSFER_CHUNK_SIZE
    assert "fileTransferRateLimit" not in features
