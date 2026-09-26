"""Setup checklist: individual checks, the console report, the dependency stamp
and the /api/preflight route (no network)."""

import asyncio
import socket

import pytest
from fastapi.testclient import TestClient

from creatio_case_lookup import env, paths, preflight, server


def blank_env(**kw):
    e = {k: "" for k in ("CREATIO_BASE_URL", "CREATIO_ALLOWED_ENTITIES", "CREATIO_LOGIN", "CREATIO_PASSWORD",
                         "CREATIO_ASPXAUTH", "CREATIO_BPMCSRF")}
    e.update(kw)
    return e


def test_python_and_packages_pass_in_this_venv():
    assert preflight.check_python()["status"] == "ok"
    assert preflight.check_packages()["status"] == "ok"


def test_missing_package_fails_with_reinstall_fix(monkeypatch):
    real = preflight.importlib.util.find_spec
    monkeypatch.setattr(preflight.importlib.util, "find_spec", lambda m: None if m == "openpyxl" else real(m))
    c = preflight.check_packages()
    assert c["status"] == "fail" and "openpyxl" in c["detail"] and "start-app.bat" in c["fix"]


def test_allowlist_names_what_each_tab_is_missing():
    c = preflight.check_allowlist(blank_env(CREATIO_ALLOWED_ENTITIES="Case,CaseFile"))
    assert c["status"] == "warn"
    assert "Lookup needs Activity, SocialMessage, Contact, Account" in c["detail"]
    assert "Lifecycle needs CaseLifecycle" in c["detail"]
    assert c["missing"] == ["Activity", "SocialMessage", "Contact", "Account", "CaseLifecycle"]
    assert c["current"] == ["Case", "CaseFile"]


def test_allowlist_complete_and_empty():
    full = ",".join(preflight.RECOMMENDED_ALLOWLIST)
    assert preflight.check_allowlist(blank_env(CREATIO_ALLOWED_ENTITIES=full))["status"] == "ok"
    empty = preflight.check_allowlist(blank_env())
    assert empty["status"] == "warn" and "every Creatio entity" in empty["detail"]


def test_sign_in_accepts_cookies_or_service_account():
    assert preflight.check_sign_in(blank_env(CREATIO_ASPXAUTH="a", CREATIO_BPMCSRF="b"))["status"] == "ok"
    assert preflight.check_sign_in(blank_env(CREATIO_LOGIN="u", CREATIO_PASSWORD="p"))["status"] == "ok"
    assert preflight.check_sign_in(blank_env())["status"] == "warn"


def test_connection_skipped_without_base_url():
    assert asyncio.run(preflight.check_connection(blank_env()))["status"] == "skip"


def test_connection_reports_failure(monkeypatch):
    from creatio_case_lookup import creatio_client

    async def bad():
        return {"ok": False, "error": "Session expired"}

    monkeypatch.setattr(creatio_client, "test_connection", bad)
    signed_in = blank_env(CREATIO_BASE_URL="https://x", CREATIO_ASPXAUTH="a", CREATIO_BPMCSRF="b")
    c = asyncio.run(preflight.check_connection(signed_in))
    assert c["status"] == "fail" and c["detail"] == "Session expired" and c["goto"] == "settings"
    # Not signed in yet: skipped rather than a second, confusing failure.
    c = asyncio.run(preflight.check_connection(blank_env(CREATIO_BASE_URL="https://x")))
    assert c["status"] == "skip"


def test_port_in_use_fails():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        s.listen()
        port = s.getsockname()[1]
        c = preflight.check_port("127.0.0.1", port)
    assert c["status"] == "fail" and c["group"] == "Required"


def test_env_file_missing(monkeypatch, tmp_path):
    monkeypatch.setattr(preflight, "ENV_PATH", tmp_path / ".env")
    assert preflight.check_env_file()["status"] == "fail"


def test_summary_and_report_mark_blocking():
    checks = [preflight._check("a", "Required", "Python", "fail", "old", "Install 3.12"),
              preflight._check("b", "Features", "Claude", "warn", "", "Install it"),
              preflight._check("c", "Connection", "Address", "ok", "https://x")]
    s = preflight.summarize(checks)
    assert s == {"ok": False, "fails": 1, "warnings": 1, "blocking": 1}
    out = preflight.format_report({"checks": checks, "summary": s})
    assert "[FAIL] Python - old" in out and "Fix: Install 3.12" in out
    assert "[ OK ] Address - https://x" in out
    assert "stop the app from starting" in out


def test_main_exit_code_follows_blocking(monkeypatch, capsys):
    async def fake(**kw):
        checks = [preflight._check("p", "Required", "Port", kw["include_port"] and "fail" or "ok")]
        return {"checks": checks, "summary": preflight.summarize(checks)}

    monkeypatch.setattr(preflight, "run_checks", fake)
    assert preflight.main([]) == 1
    assert "[FAIL] Port" in capsys.readouterr().out


def test_deps_stamp_roundtrip(monkeypatch, tmp_path):
    monkeypatch.setattr(preflight, "STAMP", tmp_path / ".deps-sha256")
    assert preflight.deps_stale() is True
    assert preflight.main(["--deps-stale"]) == 1
    assert preflight.main(["--deps-mark"]) == 0
    assert preflight.deps_stale() is False and preflight.main(["--deps-stale"]) == 0


def test_preflight_route(monkeypatch, tmp_path):
    envp = tmp_path / ".env"
    envp.write_text("CREATIO_ALLOWED_ENTITIES=Case\n", encoding="utf-8")
    monkeypatch.setattr(paths, "ENV_PATH", envp)
    monkeypatch.setattr(env, "ENV_PATH", envp)
    monkeypatch.setattr(preflight, "ENV_PATH", envp)
    for k in ("CREATIO_BASE_URL", "CREATIO_ALLOWED_ENTITIES", "CREATIO_ASPXAUTH", "CREATIO_BPMCSRF",
              "CREATIO_LOGIN", "CREATIO_PASSWORD"):
        monkeypatch.delenv(k, raising=False)
    with TestClient(server.app) as c:
        d = c.get("/api/preflight").json()
    ids = [x["id"] for x in d["checks"]]
    assert "port" not in ids  # only start-app.bat checks the port
    assert ids[:2] == ["python", "packages"]
    by = {x["id"]: x for x in d["checks"]}
    assert by["baseurl"]["status"] == "fail" and by["connection"]["status"] == "skip"
    assert by["allowlist"]["status"] == "warn"
    assert d["summary"]["fails"] >= 1
