"""creatio_client: probe contract, query encoding parity, auth/cookie handling.

No network: HTTP goes through an ``httpx.MockTransport`` injected via the
module's ``_client`` factory.
"""

import asyncio
import json
import re

import httpx
import pytest

from creatio_case_lookup import creatio_client as C
from creatio_case_lookup import env, paths


@pytest.fixture
def client_state(monkeypatch, tmp_path):
    """Isolate module globals and point `.env` at a temp file."""
    envp = tmp_path / ".env"
    monkeypatch.setattr(paths, "ENV_PATH", envp)
    monkeypatch.setattr(env, "ENV_PATH", envp)
    for k in ("CREATIO_ASPXAUTH", "CREATIO_BPMCSRF", "CREATIO_BPMLOADER"):
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setattr(C, "BASE_URL", "https://creatio.test")
    monkeypatch.setattr(C, "ALLOWED_ENTITIES", [])
    monkeypatch.setattr(C, "MAX_TOP", 50)
    monkeypatch.setattr(C, "_cookie_jar", {})
    monkeypatch.setattr(C, "_bpmcsrf", "")
    monkeypatch.setattr(C, "_last_seeded_aspx", "")
    monkeypatch.setattr(C, "_last_seeded_csrf", "")
    return envp


def _mock(monkeypatch, handler):
    calls = []

    def wrapped(request: httpx.Request):
        calls.append(request)
        return handler(request, len(calls))

    monkeypatch.setattr(
        C, "_client", lambda: httpx.AsyncClient(transport=httpx.MockTransport(wrapped), follow_redirects=True)
    )
    return calls


# --- Ported from creatioClient.test.ts -------------------------------------
def test_connection_probe_narrows_select_to_a_single_column():
    # URLSearchParams percent-encodes '$', hence %24.
    assert re.search(r"%24select=Id(&|$)", C.connection_probe_path())


def test_connection_probe_reads_a_single_row():
    assert re.search(r"%24top=1(&|$)", C.connection_probe_path())


# --- build_query parity with JS URLSearchParams -----------------------------
def test_build_query_matches_urlsearchparams(monkeypatch):
    monkeypatch.setattr(C, "MAX_TOP", 50)
    # Expected strings produced by dist/creatioClient.js buildQuery (CREATIO_MAX_TOP=50).
    q = C.build_query(
        {
            "select": ["Id", "Name"],
            "filter": "contains(Name,'O''Brien') and Owner/Id eq 1 * 2 - a.b_c~d",
            "orderby": "CreatedOn desc",
            "expand": "Owner($select=Name)",
            "top": 5,
        }
    )
    assert q == (
        "?%24select=Id%2CName&%24filter=contains%28Name%2C%27O%27%27Brien%27%29+and+Owner%2FId+eq+1+*+2+-+a.b_c%7Ed"
        "&%24orderby=CreatedOn+desc&%24expand=Owner%28%24select%3DName%29&%24top=5"
    )
    assert C.build_query(filter="a+b=c&d#e%f?g ü", top=0) == "?%24filter=a%2Bb%3Dc%26d%23e%25f%3Fg+%C3%BC&%24top=1"


def test_build_query_top_default_and_clamp(monkeypatch):
    monkeypatch.setattr(C, "MAX_TOP", 50)
    assert C.build_query() == "?%24top=50"
    assert C.build_query(top=999) == "?%24top=50"
    assert C.build_query(top=7.9) == "?%24top=7"
    assert C.build_query(select=[], filter="", top=3) == "?%24top=3"


# --- allowlist ---------------------------------------------------------------
def test_assert_entity_allowed_messages(monkeypatch):
    monkeypatch.setattr(C, "ALLOWED_ENTITIES", ["Case", "Contact"])
    C.assert_entity_allowed("Case")
    with pytest.raises(Exception, match=r"^Invalid entity name: Case\(x\)$"):
        C.assert_entity_allowed("Case(x)")
    with pytest.raises(Exception, match="Invalid entity name"):
        C.assert_entity_allowed("Case\n")
    with pytest.raises(Exception) as ei:
        C.assert_entity_allowed("Account")
    assert str(ei.value) == (
        'Entity "Account" is not in the allowlist (Case, Contact). Edit CREATIO_ALLOWED_ENTITIES to permit it.'
    )
    monkeypatch.setattr(C, "ALLOWED_ENTITIES", [])
    C.assert_entity_allowed("Anything_1")


# --- cookies -----------------------------------------------------------------
def test_resolve_cookie_env_file_beats_process_env_and_strips_prefixes(client_state, monkeypatch):
    client_state.write_text(
        "CREATIO_ASPXAUTH=.ASPXAUTH=fileaspx\nCREATIO_BPMCSRF=bpmcsrf=filecsrf\nCREATIO_BPMLOADER=\n",
        encoding="utf-8",
    )
    monkeypatch.setenv("CREATIO_ASPXAUTH", "envaspx")
    monkeypatch.setenv("CREATIO_BPMLOADER", "envloader")
    # An empty value present in the file still wins over the process env.
    assert C.resolve_cookie_env() == {"aspx": "fileaspx", "csrf": "filecsrf", "loader": ""}
    client_state.write_text("", encoding="utf-8")
    monkeypatch.setenv("CREATIO_BPMCSRF", " BPMCSRF=envcsrf ")
    assert C.resolve_cookie_env() == {"aspx": "envaspx", "csrf": "envcsrf", "loader": "envloader"}


def test_store_set_cookies_reads_every_header(client_state):
    res = httpx.Response(
        200,
        headers=[
            ("set-cookie", ".ASPXAUTH=abc; path=/; HttpOnly"),
            ("set-cookie", "BPMCSRF=tok123; path=/"),
            ("set-cookie", "garbage"),
        ],
    )
    C.store_set_cookies(res)
    assert C._cookie_jar == {".ASPXAUTH": "abc", "BPMCSRF": "tok123"}
    assert C._bpmcsrf == "tok123"


def test_seed_and_login_cookie_mode_detects_expiry(client_state):
    client_state.write_text("CREATIO_ASPXAUTH=a1\nCREATIO_BPMCSRF=c1\nCREATIO_BPMLOADER=l1\n", encoding="utf-8")
    asyncio.run(C.login())
    assert C._cookie_jar == {".ASPXAUTH": "a1", "BPMCSRF": "c1", "BPMLOADER": "l1"}
    assert C._bpmcsrf == "c1"
    # Same cookies on disk -> expired.
    with pytest.raises(C.AuthError, match="Creatio session cookies have expired"):
        asyncio.run(C.login())
    # Refreshed .env -> re-seeded silently.
    client_state.write_text("CREATIO_ASPXAUTH=a2\nCREATIO_BPMCSRF=c2\n", encoding="utf-8")
    asyncio.run(C.login())
    assert C._cookie_jar == {".ASPXAUTH": "a2", "BPMCSRF": "c2"}


def test_login_requires_base_url(client_state, monkeypatch):
    monkeypatch.setattr(C, "BASE_URL", "")
    with pytest.raises(Exception, match=r"CREATIO_BASE_URL"):
        asyncio.run(C.login())


def test_forms_login_posts_and_stores_csrf(client_state, monkeypatch):
    monkeypatch.setattr(C, "_LOGIN", "me")
    monkeypatch.setattr(C, "_PASSWORD", "pw")

    def handler(req, n):
        assert req.method == "POST"
        assert req.url.path == "/ServiceModel/AuthService.svc/Login"
        assert json.loads(req.content) == {"UserName": "me", "UserPassword": "pw"}
        return httpx.Response(
            200,
            json={"Code": 0},
            headers=[("set-cookie", ".ASPXAUTH=x; path=/"), ("set-cookie", "BPMCSRF=y; path=/")],
        )

    _mock(monkeypatch, handler)
    asyncio.run(C.login())
    assert C._bpmcsrf == "y"


def test_forms_login_failure_message(client_state, monkeypatch):
    _mock(monkeypatch, lambda req, n: httpx.Response(200, json={"Code": 1, "Message": "bad creds"}))
    with pytest.raises(Exception) as ei:
        asyncio.run(C.login())
    assert str(ei.value) == "Creatio login failed (Code=1): bad creds"

    _mock(monkeypatch, lambda req, n: httpx.Response(500, text="not json"))
    with pytest.raises(Exception) as ei:
        asyncio.run(C.login())
    assert str(ei.value) == "Creatio login failed (Code=undefined): Internal Server Error"

    _mock(monkeypatch, lambda req, n: httpx.Response(200, json={"Code": 0}))
    with pytest.raises(Exception) as ei:
        asyncio.run(C.login())
    assert str(ei.value) == "Creatio login succeeded but no BPMCSRF cookie was returned."


# --- odata_get -----------------------------------------------------------------
def test_odata_get_sends_session_headers_and_parses(client_state, monkeypatch):
    client_state.write_text("CREATIO_ASPXAUTH=a1\nCREATIO_BPMCSRF=c1\n", encoding="utf-8")

    def handler(req, n):
        assert req.method == "GET"
        assert str(req.url) == "https://creatio.test/0/odata/Case?%24top=1"
        assert req.headers["Accept"] == "application/json"
        assert req.headers["Cookie"] == ".ASPXAUTH=a1; BPMCSRF=c1"
        assert req.headers["BPMCSRF"] == "c1"
        assert req.headers["ForceUseSession"] == "true"
        return httpx.Response(200, json={"value": [{"Id": "1"}]})

    _mock(monkeypatch, handler)
    assert asyncio.run(C.odata_get("Case?%24top=1")) == {"value": [{"Id": "1"}]}


def test_odata_get_empty_body_is_empty_dict(client_state, monkeypatch):
    client_state.write_text("CREATIO_ASPXAUTH=a1\nCREATIO_BPMCSRF=c1\n", encoding="utf-8")
    _mock(monkeypatch, lambda req, n: httpx.Response(200, text=""))
    assert asyncio.run(C.odata_get("Case")) == {}


def test_odata_get_relogins_once_on_401_with_refreshed_cookies(client_state, monkeypatch):
    client_state.write_text("CREATIO_ASPXAUTH=old\nCREATIO_BPMCSRF=oldc\n", encoding="utf-8")
    seen = []

    def handler(req, n):
        seen.append(req.headers["Cookie"])
        if n == 1:
            # Simulate the user refreshing .env while the session was expiring.
            client_state.write_text("CREATIO_ASPXAUTH=new\nCREATIO_BPMCSRF=newc\n", encoding="utf-8")
            return httpx.Response(401)
        return httpx.Response(200, json={"ok": True})

    _mock(monkeypatch, handler)
    assert asyncio.run(C.odata_get("Case")) == {"ok": True}
    assert seen == [".ASPXAUTH=old; BPMCSRF=oldc", ".ASPXAUTH=new; BPMCSRF=newc"]


def test_odata_get_unchanged_cookies_raise_auth_error(client_state, monkeypatch):
    client_state.write_text("CREATIO_ASPXAUTH=a\nCREATIO_BPMCSRF=c\n", encoding="utf-8")
    _mock(monkeypatch, lambda req, n: httpx.Response(403))
    with pytest.raises(C.AuthError, match="expired"):
        asyncio.run(C.odata_get("Case"))


def test_odata_get_error_string(client_state, monkeypatch):
    client_state.write_text("CREATIO_ASPXAUTH=a\nCREATIO_BPMCSRF=c\n", encoding="utf-8")
    _mock(monkeypatch, lambda req, n: httpx.Response(500, text="x" * 600))
    with pytest.raises(Exception) as ei:
        asyncio.run(C.odata_get("Case?%24top=1"))
    assert str(ei.value) == "OData GET /Case?%24top=1 -> 500 Internal Server Error: " + "x" * 500


def test_query_records_returns_value_or_empty(client_state, monkeypatch):
    client_state.write_text("CREATIO_ASPXAUTH=a\nCREATIO_BPMCSRF=c\n", encoding="utf-8")
    _mock(monkeypatch, lambda req, n: httpx.Response(200, json={"value": [1, 2]}))
    assert asyncio.run(C.query_records("Case", select=["Id"])) == [1, 2]
    _mock(monkeypatch, lambda req, n: httpx.Response(200, json={}))
    assert asyncio.run(C.query_records("Case")) == []


# --- download_file -------------------------------------------------------------
GUID = "0123abcd-0123-4567-89ab-0123456789ab"


def test_download_file_validation(client_state):
    with pytest.raises(Exception, match='File entity "SysImage" is not downloadable.'):
        asyncio.run(C.download_file("SysImage", GUID))
    with pytest.raises(Exception, match="Invalid file id: ../x"):
        asyncio.run(C.download_file("CaseFile", "../x"))


def test_download_file_returns_buffer_and_filename(client_state, monkeypatch):
    client_state.write_text("CREATIO_ASPXAUTH=a\nCREATIO_BPMCSRF=c\n", encoding="utf-8")

    def handler(req, n):
        assert str(req.url) == f"https://creatio.test/0/rest/FileService/Download/CaseFile/{GUID}"
        assert req.headers["Accept"] == "*/*"
        return httpx.Response(
            200,
            content=b"\x89PNG",
            headers={"content-type": "image/png", "content-disposition": 'attachment; filename="shot 1.png"'},
        )

    _mock(monkeypatch, handler)
    out = asyncio.run(C.download_file("CaseFile", GUID))
    assert out == {"buffer": b"\x89PNG", "contentType": "image/png", "filename": "shot 1.png"}

    _mock(monkeypatch, lambda req, n: httpx.Response(200, content=b""))
    assert asyncio.run(C.download_file("FeedFile", GUID)) == {
        "buffer": b"",
        "contentType": "application/octet-stream",
    }


# --- describe_error / test_connection -----------------------------------------
def test_describe_error_walks_chain():
    try:
        try:
            try:
                raise OSError("ECONNRESET")
            except OSError as inner:
                raise ValueError("socket hang up") from inner
        except ValueError:
            raise RuntimeError("fetch failed")  # implicit __context__
    except RuntimeError as e:
        assert C.describe_error(e) == "fetch failed (socket hang up → ECONNRESET)"
    assert C.describe_error(RuntimeError("plain")) == "plain"
    assert C.describe_error("str") == "str"


def test_test_connection_reports_failure(client_state, monkeypatch):
    monkeypatch.setattr(C, "BASE_URL", "")
    assert asyncio.run(C.test_connection()) == {
        "ok": False,
        "error": "Creatio base URL is not configured (CREATIO_BASE_URL). Set it in Settings / .env.",
    }
