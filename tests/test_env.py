"""`.env` read/write round-trip (env.py)."""

from creatio_case_lookup import env, paths


def _use(tmp_path, monkeypatch, content: bytes | None = None):
    p = tmp_path / ".env"
    if content is not None:
        p.write_bytes(content)
    monkeypatch.setattr(paths, "ENV_PATH", p)
    monkeypatch.setattr(env, "ENV_PATH", p)
    return p


def test_read_parses_quotes_comments_and_crlf(tmp_path, monkeypatch):
    _use(
        tmp_path,
        monkeypatch,
        b'# comment\r\nA=1\r\n  B = "two words"  \r\nC=\'single\'\r\n\r\nD=x#not-a-comment\r\n'
        b'NOEQUALS\r\nE="mismatched\'\r\nF=a=b\r\n',
    )
    assert env.read_env_file() == {
        "A": "1",
        "B": "two words",
        "C": "single",
        "D": "x#not-a-comment",
        "E": "\"mismatched'",
        "F": "a=b",
    }


def test_read_missing_file_is_empty(tmp_path, monkeypatch):
    _use(tmp_path, monkeypatch)
    assert env.read_env_file() == {}


def test_write_replaces_in_place_appends_new_and_uses_lf(tmp_path, monkeypatch):
    p = _use(tmp_path, monkeypatch, b"# header\r\nA=1\r\n# keep me\r\nB=2\r\n")
    env.write_env_file({"B": "20", "NEW": "x y", "A": '"quoted"'})
    raw = p.read_bytes()
    assert b"\r" not in raw
    # NOTE: the TS writer (split on /\r?\n/) would leave a blank line before
    # NEW here; env.py uses splitlines() and does not.
    assert raw.decode("utf-8") == '# header\nA="quoted"\n# keep me\nB=20\nNEW=x y\n'
    # And it round-trips.
    assert env.read_env_file() == {"A": "quoted", "B": "20", "NEW": "x y"}


def test_write_creates_file(tmp_path, monkeypatch):
    p = _use(tmp_path, monkeypatch)
    env.write_env_file({"K": "v"})
    assert p.read_text(encoding="utf-8") == "K=v\n"


def test_write_clearing_a_value(tmp_path, monkeypatch):
    p = _use(tmp_path, monkeypatch, b"CREATIO_WORKSPACE_CASE=SR00012345\n")
    env.write_env_file({"CREATIO_WORKSPACE_CASE": ""})
    assert p.read_text(encoding="utf-8") == "CREATIO_WORKSPACE_CASE=\n"
    assert env.read_env_file() == {"CREATIO_WORKSPACE_CASE": ""}


def test_env_first_prefers_process_env(tmp_path, monkeypatch):
    _use(tmp_path, monkeypatch, b"X_TEST_KEY=from-file\n")
    monkeypatch.delenv("X_TEST_KEY", raising=False)
    assert env.env_first("X_TEST_KEY") == "from-file"
    monkeypatch.setenv("X_TEST_KEY", "  from-env ")
    assert env.env_first("X_TEST_KEY") == "from-env"


def test_clamp_int():
    assert env.clamp_int(None, 50, 1, 500) == 50
    assert env.clamp_int("abc", 50, 1, 500) == 50
    assert env.clamp_int("0", 50, 1, 500) == 1
    assert env.clamp_int("9999", 50, 1, 500) == 500
    assert env.clamp_int("42", 50, 1, 500) == 42
