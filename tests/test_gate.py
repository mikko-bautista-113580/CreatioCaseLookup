"""Sign-in gate: identity cookie format (must match the router's nginx
secure_link check), identity parsing/matching, and the routes (no browser)."""

import base64
import hashlib
import time
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from creatio_case_lookup import gate


@pytest.fixture(autouse=True)
def config(monkeypatch):
    monkeypatch.setenv("GATE_SECRET", "s" * 32)
    monkeypatch.setenv("GATE_DEVELOPERS", '{"lester": ["Lester@Example.com", "113580@example.com"], "maria": "maria@example.com"}')
    monkeypatch.setattr(gate, "_tickets", {})
    monkeypatch.setattr(gate, "_active_viewer", None)


def test_sign_matches_nginx_secure_link_md5():
    # nginx: secure_link_md5 "$exp:$name:<secret>" → base64url(md5), no padding
    want = base64.urlsafe_b64encode(hashlib.md5(f"123:lester:{'s' * 32}".encode()).digest()).decode().rstrip("=")
    assert gate.sign("lester", 123) == want
    value, max_age = gate.id_cookie("lester", now=1000)
    assert value == f"lester.{1000 + max_age}.{gate.sign('lester', 1000 + max_age)}"


def test_identity_fields_handles_wrapped_json_string():
    reply = {"getCurrentUserInfoResult": '{"ContactId": "11111111-2222-3333-4444-555555555555", '
                                         '"ContactName": "Lester Bautista", "UserName": "lbautist"}'}
    assert gate.identity_fields(reply) == {"contactId": "11111111-2222-3333-4444-555555555555",
                                           "name": "Lester Bautista", "login": "lbautist"}


def test_match_prefers_creatio_then_microsoft_account():
    assert gate.match({"email": "lester@example.com"}, []) == "lester"
    assert gate.match({"name": "Someone"}, ["113580@example.com"]) == "lester"
    assert gate.match({"email": "maria@example.com"}, ["113580@example.com"]) == "maria"
    assert gate.match({"email": "stranger@example.com"}, []) is None


def test_microsoft_login_captured_from_sso_post():
    req = SimpleNamespace(method="POST", url="https://login.microsoftonline.com/common/login",
                          post_data="i13=0&login=113580%40example.com&loginfmt=113580%40example.com&type=11")
    assert gate.microsoft_logins(req) == ["113580@example.com", "113580@example.com"]
    assert gate.microsoft_logins(SimpleNamespace(method="GET", url=req.url, post_data="")) == []


def test_page_sets_viewer_cookie_and_viewer_check():
    with TestClient(gate.app, base_url="https://testserver") as c:
        r = c.get("/")
        assert "Log in with Creatio" in r.text and gate.VIEWER_COOKIE in r.cookies
        assert c.get("/_gate/viewer-ok").status_code == 403  # nobody is signing in
        gate._active_viewer = r.cookies[gate.VIEWER_COOKIE]
        assert c.get("/_gate/viewer-ok").status_code == 204
        c.cookies.set(gate.VIEWER_COOKIE, "someone-else")
        assert c.get("/_gate/viewer-ok").status_code == 403


def test_enter_ticket_sets_identity_cookie_once():
    gate._tickets["t1"] = ("lester", time.time() + 60)
    with TestClient(gate.app, base_url="https://testserver") as c:
        r = c.get("/_gate/enter?t=t1", follow_redirects=False)
        assert r.status_code == 302 and r.cookies[gate.ID_COOKIE].startswith("lester.")
        r = c.get("/_gate/enter?t=t1", follow_redirects=False)
        assert gate.ID_COOKIE not in r.cookies


def test_login_needs_viewer_cookie():
    with TestClient(gate.app, base_url="https://testserver") as c:
        assert c.post("/_gate/login").status_code == 400


def test_login_flow_with_fake_browser(monkeypatch):
    from creatio_case_lookup import browser_login

    async def fake_login(base_url, progress, *, profile_dir, on_context):
        on_context(SimpleNamespace(on=lambda *_: None))
        progress("Waiting for you to finish logging in…")
        return {"aspx": "A", "csrf": "C", "loader": ""}

    async def fake_identity(base_url, cookies):
        return {"email": "maria@example.com"}

    handed = {}

    async def fake_hand_off(name, cookies, who=None):
        handed[name] = cookies
        handed["who"] = who
        return {"connection": {"ok": True}}

    monkeypatch.setattr(browser_login, "login_via_browser", fake_login)
    monkeypatch.setattr(gate, "creatio_identity", fake_identity)
    monkeypatch.setattr(gate, "hand_off", fake_hand_off)
    with TestClient(gate.app, base_url="https://testserver") as c:
        c.get("/")
        body = c.post("/_gate/login").text
        assert "event: done" in body and '"name": "maria"' in body
        enter = body.split('"enter": "')[1].split('"')[0]
        r = c.get(enter, follow_redirects=False)
        assert r.cookies[gate.ID_COOKIE].startswith("maria.")
    assert handed["maria"]["aspx"] == "A"


def test_login_flow_unknown_user(monkeypatch):
    from creatio_case_lookup import browser_login

    async def fake_login(base_url, progress, *, profile_dir, on_context):
        return {"aspx": "A", "csrf": "C", "loader": ""}

    async def fake_identity(base_url, cookies):
        return {"email": "stranger@example.com", "name": "A Stranger"}

    monkeypatch.setattr(browser_login, "login_via_browser", fake_login)
    monkeypatch.setattr(gate, "creatio_identity", fake_identity)
    with TestClient(gate.app, base_url="https://testserver") as c:
        c.get("/")
        body = c.post("/_gate/login").text
    assert "event: error" in body and "stranger@example.com" in body and "haven't been added" in body
