from syncplay.utils import meetsMinVersion


def test_meets_min_version_accepts_client_suffixes():
    assert meetsMinVersion("1.7.6-rn.1", "1.7.0")
    assert not meetsMinVersion("1.1.0-rn.1", "1.2.0")
