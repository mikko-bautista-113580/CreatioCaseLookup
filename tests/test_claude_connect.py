"""Connect Claude (claude setup-token driven from the Setup tab): output parsing,
the two routes, and — where a POSIX pty exists — the real flow against a fake CLI."""

import os
import stat
import sys
import textwrap

import pytest
from fastapi.testclient import TestClient

from creatio_case_lookup import claude_connect, env, paths, server

# What `claude setup-token` printed under a pty (v2.1.286), PKCE values shortened
SAMPLE = (
    "\x1b7\x1b8Welcome\x1b[1Cto\x1b[1CClaude\x1b[1CCode\r\n"
    "\x1b[2K\rBrowser didn't open? Use the url below to sign in (c to copy)\r\n\r\n"
    "https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c&response_type=code"
    "&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=user%3Ainference"
    "&code_challenge=abc&code_challenge_method=S256&state=xyz\r\n\r\n"
    "Paste\x1b[1Ccode\x1b[1Chere\x1b[1Cif\x1b[1Cprompted\x1b[1C>\r\n"
)
TOKEN = "sk-ant-oat01-" + "A1b2_C3-d4" * 9


def test_finds_sign_in_url():
    url = claude_connect.find_url(SAMPLE)
    assert url.startswith("https://claude.com/cai/oauth/authorize?code=true")
    assert url.endswith("state=xyz")


def test_finds_token_without_gluing_following_text():
    out = f"\x1b[32m✓\x1b[39m Long-lived token created\r\n{TOKEN}\x1b[1CStore\x1b[1Cthis\x1b[1Ctoken"
    assert claude_connect.find_token(out) == TOKEN
    assert claude_connect.find_token(SAMPLE) is None


def test_start_unsupported_says_use_terminal(monkeypatch):
    monkeypatch.setattr(claude_connect, "supported", lambda: False)
    with pytest.raises(claude_connect.ConnectError, match="run `claude`"):
        claude_connect.start()


def test_finish_without_a_started_flow(monkeypatch):
    monkeypatch.setattr(claude_connect, "_flow", None)
    with pytest.raises(claude_connect.ConnectError, match="expired"):
        claude_connect.finish("abc#def")
    with pytest.raises(claude_connect.ConnectError, match="Paste the code"):
        claude_connect.finish("  ")


def test_routes(monkeypatch):
    monkeypatch.setattr(claude_connect, "start", lambda: "https://claude.com/cai/oauth/authorize?x=1")
    seen = {}
    monkeypatch.setattr(claude_connect, "finish", lambda code: seen.setdefault("code", code))
    with TestClient(server.app) as c:
        assert c.post("/api/claude-connect/start").json() == {"url": "https://claude.com/cai/oauth/authorize?x=1"}
        assert c.post("/api/claude-connect/finish", json={"code": "abc#def"}).json() == {"ok": True}
    assert seen["code"] == "abc#def"


def test_route_reports_connect_errors(monkeypatch):
    def bad(code):
        raise claude_connect.ConnectError("Claude didn't accept the code.")

    monkeypatch.setattr(claude_connect, "finish", bad)
    with TestClient(server.app) as c:
        r = c.post("/api/claude-connect/finish", json={"code": "nope"})
    assert r.status_code == 400 and "didn't accept" in r.json()["message"]


@pytest.mark.skipif(not claude_connect.supported(), reason="needs a POSIX pty")
def test_full_flow_against_fake_cli(monkeypatch, tmp_path):
    fake = tmp_path / "claude"
    fake.write_text(textwrap.dedent(f"""\
        #!{sys.executable}
        import sys
        print({SAMPLE!r}, end="", flush=True)
        code = sys.stdin.readline().strip()
        print("\\r\\n" + ("{TOKEN}" if code == "good#code" else "OAuth error: invalid code"), flush=True)
    """))
    fake.chmod(fake.stat().st_mode | stat.S_IEXEC)
    monkeypatch.setenv("PATH", f"{tmp_path}{os.pathsep}{os.environ['PATH']}")
    envp = tmp_path / ".env"
    monkeypatch.setattr(paths, "ENV_PATH", envp)
    monkeypatch.setattr(env, "ENV_PATH", envp)
    monkeypatch.delenv(claude_connect.TOKEN_KEY, raising=False)

    assert "oauth/authorize" in claude_connect.start(timeout_s=10)
    with pytest.raises(claude_connect.ConnectError, match="invalid code"):
        claude_connect.finish("bad", timeout_s=5)

    claude_connect.start(timeout_s=10)
    claude_connect.finish("good#code", timeout_s=10)
    assert os.environ[claude_connect.TOKEN_KEY] == TOKEN
    assert f"{claude_connect.TOKEN_KEY}={TOKEN}" in envp.read_text()


def test_disconnect_forgets_token(monkeypatch, tmp_path):
    envp = tmp_path / ".env"
    envp.write_text(f"{claude_connect.TOKEN_KEY}={TOKEN}\nOTHER=1\n", encoding="utf-8")
    monkeypatch.setattr(paths, "ENV_PATH", envp)
    monkeypatch.setattr(env, "ENV_PATH", envp)
    monkeypatch.setenv(claude_connect.TOKEN_KEY, TOKEN)
    with TestClient(server.app) as c:
        assert c.post("/api/claude-connect/disconnect").json() == {"ok": True}
    assert claude_connect.TOKEN_KEY not in os.environ
    assert TOKEN not in envp.read_text() and "OTHER=1" in envp.read_text()
