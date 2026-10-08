"""Whose Creatio session it is: the identity lookup, saving the user's name,
and the "e.g. …" placeholder name the app serves (no network)."""

import asyncio
import json

import httpx
import pytest
from fastapi.testclient import TestClient

from creatio_case_lookup import creatio_identity as ci
from creatio_case_lookup import env, paths, server

CID = "11111111-2222-3333-4444-555555555555"


@pytest.fixture
def envp(monkeypatch, tmp_path):
    p = tmp_path / ".env"
    p.write_text("", encoding="utf-8")
    monkeypatch.setattr(paths, "ENV_PATH", p)
    monkeypatch.setattr(env, "ENV_PATH", p)
    return p


def fake_creatio(monkeypatch, user_info, contact=None):
    seen = []

    def handler(req: httpx.Request) -> httpx.Response:
        seen.append((req.method, req.url.path, req.headers.get("BPMCSRF")))
        if req.url.path.endswith("/getCurrentUserInfo"):
            return httpx.Response(200, json=user_info)
        if f"Contact({CID})" in req.url.path and contact is not None:
            return httpx.Response(200, json=contact)
        return httpx.Response(404)

    real = httpx.AsyncClient
    monkeypatch.setattr(ci.httpx, "AsyncClient", lambda **kw: real(transport=httpx.MockTransport(handler), **kw))
    return seen


def test_identity_uses_contact_name_and_email(monkeypatch):
    seen = fake_creatio(monkeypatch, {"getCurrentUserInfoResult": json.dumps({"ContactId": CID, "UserName": "lbautist"})},
                        {"Name": "Lester Mikko Bautista", "Email": "Lester@Example.com"})
    who = asyncio.run(ci.creatio_identity("https://x", {"aspx": "A", "csrf": "C"}))
    assert who == {"contactId": CID, "login": "lbautist", "name": "Lester Mikko Bautista", "email": "Lester@Example.com"}
    assert all(csrf == "C" for _, _, csrf in seen) and all(m in ("GET", "POST") for m, _, _ in seen)


def test_remember_user_name_saves_to_env(monkeypatch, envp):
    fake_creatio(monkeypatch, {"ContactId": CID}, {"Name": "Lester Mikko Bautista"})
    assert asyncio.run(ci.remember_user_name("https://x", {"aspx": "A", "csrf": "C"})) == "Lester Mikko Bautista"
    assert f"{ci.USER_NAME_KEY}=Lester Mikko Bautista" in envp.read_text()


def test_remember_user_name_unknown_saves_nothing(monkeypatch, envp):
    fake_creatio(monkeypatch, {})
    assert asyncio.run(ci.remember_user_name("https://x", {"aspx": "A", "csrf": "C"})) == ""
    assert ci.USER_NAME_KEY not in envp.read_text()


def test_meta_prefers_creatio_user_over_windows(monkeypatch, envp):
    monkeypatch.setattr(server, "_WINDOWS_NAME", "Windows Person")
    with TestClient(server.app) as c:
        assert c.get("/api/meta").json()["userName"] == "Windows Person"
        envp.write_text(f"{ci.USER_NAME_KEY}=Bautista, Lester Mikko\n", encoding="utf-8")
        assert c.get("/api/meta").json()["userName"] == "Lester Mikko Bautista"


def test_config_accepts_user_name_from_gate(monkeypatch, envp):
    async def ok():
        return {"ok": True}

    monkeypatch.setattr(server, "test_connection", ok)

    async def must_not_look_up(*a):
        raise AssertionError("the gate already said who it is")

    monkeypatch.setattr(server, "remember_user_name", must_not_look_up)
    with TestClient(server.app) as c:
        c.post("/api/config", json={"aspx": "A", "csrf": "C", "userName": "Maria Santos"})
    assert f"{ci.USER_NAME_KEY}=Maria Santos" in envp.read_text()


def test_config_looks_up_user_for_new_cookies(monkeypatch, envp):
    async def ok():
        return {"ok": True}

    looked = {}

    async def remember(base, cookies):
        looked["cookies"] = cookies
        return "X"

    monkeypatch.setattr(server, "test_connection", ok)
    monkeypatch.setattr(server, "remember_user_name", remember)
    with TestClient(server.app) as c:
        c.post("/api/config", json={"aspx": "A", "csrf": "C"})
    assert looked["cookies"]["aspx"] == "A"
