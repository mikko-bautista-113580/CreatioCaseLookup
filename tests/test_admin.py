"""Developers tab: hidden unless CCL_ADMIN=1, input checks, and the plan guard."""

import pytest
from fastapi.testclient import TestClient

from creatio_case_lookup import admin, server

CFG = {"developers": {"lester": ["lester@nelnet.net"]}, "allowed_cidrs": ["1.2.3.4/32"]}


def test_routes_hidden_without_admin(monkeypatch):
    monkeypatch.delenv("CCL_ADMIN", raising=False)
    with TestClient(server.app) as c:
        assert c.get("/api/meta").json()["admin"] is False
        assert c.get("/api/admin/status").status_code == 404
        assert c.post("/api/admin/azure-login").status_code == 404
        assert c.post("/api/admin/developers", json={"name": "x"}).status_code == 404


def test_status_when_admin(monkeypatch):
    monkeypatch.setenv("CCL_ADMIN", "1")

    async def account():
        return "lester@nelnet.net"

    async def config():
        return CFG

    monkeypatch.setattr(admin, "azure_account", account)
    monkeypatch.setattr(admin, "read_config", config)
    with TestClient(server.app) as c:
        assert c.get("/api/meta").json()["admin"] is True
        d = c.get("/api/admin/status").json()
    assert d["azureUser"] == "lester@nelnet.net" and d["developers"] == CFG["developers"]


def test_validate_normalises_and_rejects():
    assert admin.validate(" Maria ", ["Maria@Nelnet.net", ""], "5.6.7.8", CFG) == ("maria", ["maria@nelnet.net"], "5.6.7.8/32")
    for name, emails, ip, msg in [
        ("lester", ["x@nelnet.net"], "", "already a developer"),
        ("gate", ["x@nelnet.net"], "", "Name"),
        ("1bad", ["x@nelnet.net"], "", "Name"),
        ("maria", [], "", "email"),
        ("maria", ["not-an-email"], "", "email"),
        ("maria", ["lester@nelnet.net"], "", "another developer"),
        ("maria", ["m@nelnet.net"], "abc", "IP"),
    ]:
        with pytest.raises(admin.AdminError, match=msg):
            admin.validate(name, emails, ip, CFG)


def rc(addr, *actions):
    return {"address": addr, "change": {"actions": list(actions)}}


def test_plan_guard_allows_only_the_new_developer():
    ok = {"resource_changes": [
        rc('azurerm_container_app.web["maria"]', "create"),
        rc('azurerm_storage_share.state["maria"]', "create"),
        rc("azurerm_container_app.router", "update"),
        rc("azurerm_container_app.gate", "update"),
        rc('azurerm_container_app.web["lester"]', "no-op"),
        rc("data.azurerm_key_vault_secret.developers_config", "read"),
    ]}
    assert admin.plan_problems(ok, "maria") == []
    bad = {"resource_changes": [
        rc('azurerm_container_app.web["lester"]', "update"),
        rc('azurerm_storage_share.state["john"]', "delete"),
        rc("azurerm_key_vault.kv", "delete", "create"),
    ]}
    assert admin.plan_problems(bad, "maria") == [
        'update azurerm_container_app.web["lester"]',
        'delete azurerm_storage_share.state["john"]',
        "delete/create azurerm_key_vault.kv",
    ]


def test_add_refused_plan_restores_list(monkeypatch, tmp_path):
    written = []

    async def account():
        return "lester@nelnet.net"

    async def read():
        return {"developers": dict(CFG["developers"]), "allowed_cidrs": list(CFG["allowed_cidrs"])}

    async def write(cfg):
        written.append(cfg)

    async def fake_stream(*args, cwd, env):
        yield "exit", 0

    async def fake_run(*args, **kw):
        import json
        return 0, json.dumps({"resource_changes": [rc('azurerm_container_app.web["lester"]', "update")]})

    monkeypatch.setenv("CCL_INFRA_DIR", str(tmp_path))
    monkeypatch.setattr(admin, "azure_account", account)
    monkeypatch.setattr(admin, "read_config", read)
    monkeypatch.setattr(admin, "write_config", write)
    monkeypatch.setattr(admin, "_stream", fake_stream)
    monkeypatch.setattr(admin, "_run", fake_run)

    async def go():
        return [e async for e in admin.add_developer("maria", ["m@nelnet.net"], "")]

    import asyncio
    with pytest.raises(admin.AdminError, match="Not applied"):
        asyncio.run(go())
    assert "maria" in written[0]["developers"]
    assert written[-1]["developers"] == CFG["developers"]  # put back
