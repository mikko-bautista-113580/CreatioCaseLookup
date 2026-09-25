"""Shared, read-only Creatio OData client.

SAFETY MODEL
 - Every OData call goes through :func:`odata_get`, whose HTTP method is
   hard-coded to GET. There is no create/update/delete path anywhere in this
   module, so every consumer (MCP server, web app) is read-only by
   construction. (The only POST is the forms-auth login itself.)
 - An optional entity allowlist (CREATIO_ALLOWED_ENTITIES) restricts which
   OData entity sets are reachable; ``$top`` is clamped to CREATIO_MAX_TOP.

AUTH — two modes, auto-selected:
 1. Forms auth via /ServiceModel/AuthService.svc/Login (CREATIO_LOGIN +
    CREATIO_PASSWORD). Session re-established automatically on 401.
 2. Cookie auth (CREATIO_ASPXAUTH + CREATIO_BPMCSRF [+ CREATIO_BPMLOADER]) for
    SSO tenants. The cookies live in the `.env` FILE and are re-read on demand,
    so refreshing them there takes effect on the next query — no restart.

The module-level cookie jar below is the single source of truth for session
cookies. httpx never persists cookies here: every request uses a fresh client
and sends the jar explicitly in a ``Cookie`` header.
"""

from __future__ import annotations

import json
import os
import re
from collections.abc import Mapping
from typing import Any
from urllib.parse import quote_plus

import httpx

from .env import clamp_int, env_first, read_env_file

# ---------------------------------------------------------------------------
# Config resolution
# ---------------------------------------------------------------------------
# Stable config (resolved once at import; changing these needs a restart).
# env.py has already copied `.env` into os.environ WITHOUT overriding values the
# MCP client baked into its registration. SSO cookies are handled separately
# (resolve_cookie_env), reading the file live.
BASE_URL: str = re.sub(r"/+$", "", env_first("CREATIO_BASE_URL"))
ALLOWED_ENTITIES: list[str] = [
    s.strip() for s in env_first("CREATIO_ALLOWED_ENTITIES").split(",") if s.strip()
]
MAX_TOP: int = clamp_int(env_first("CREATIO_MAX_TOP") or None, 50, 1, 500)

# FileService entities the download proxy may fetch (case/feed/email attachments).
# Kept tight so the proxy can't be pointed at arbitrary file records.
FILE_DOWNLOAD_ENTITIES: list[str] = ["CaseFile", "FeedFile", "ActivityFile"]

# fetch() has no timeout at all; a generous one here keeps a dead connection
# from hanging a request forever without cutting off slow-but-healthy reads.
_TIMEOUT = httpx.Timeout(120.0, connect=30.0)

_ENTITY_RE = re.compile(r"[A-Za-z][A-Za-z0-9_]*")
_GUID_RE = re.compile(r"[0-9a-fA-F-]{36}")


def resolve_cookie_env() -> dict[str, str]:
    """Resolve the three SSO cookies, preferring the `.env` FILE on disk over
    the process environment — so refreshing `.env` (and nothing else) always
    takes effect, even if the MCP client's registration baked in stale cookie
    values. Normalization mirrors the accepted paste formats (bare value or
    ``Name=value``). Returns ``{"aspx", "csrf", "loader"}``.
    """
    file = read_env_file()

    def pick(name: str) -> str:
        # A key present in the file wins even when its value is empty.
        v = file[name] if name in file else os.environ.get(name, "")
        return (v or "").strip()

    return {
        "aspx": re.sub(r"^\.?ASPXAUTH=", "", pick("CREATIO_ASPXAUTH"), flags=re.I),
        "csrf": re.sub(r"^BPMCSRF=", "", pick("CREATIO_BPMCSRF"), flags=re.I),
        "loader": re.sub(r"^BPMLOADER=", "", pick("CREATIO_BPMLOADER"), flags=re.I),
    }


_INITIAL_COOKIES = resolve_cookie_env()
COOKIE_MODE: bool = bool(_INITIAL_COOKIES["aspx"] and _INITIAL_COOKIES["csrf"])

# Forms auth is only used when NOT in cookie mode.
_LOGIN = env_first("CREATIO_LOGIN")
_PASSWORD = env_first("CREATIO_PASSWORD")


def assert_entity_allowed(entity: str) -> None:
    if not isinstance(entity, str) or not _ENTITY_RE.fullmatch(entity):
        raise ValueError(f"Invalid entity name: {entity}")
    if ALLOWED_ENTITIES and entity not in ALLOWED_ENTITIES:
        raise ValueError(
            f'Entity "{entity}" is not in the allowlist ({", ".join(ALLOWED_ENTITIES)}). '
            "Edit CREATIO_ALLOWED_ENTITIES to permit it."
        )


# ---------------------------------------------------------------------------
# Auth + HTTP (GET only)
# ---------------------------------------------------------------------------
_cookie_jar: dict[str, str] = {}
_bpmcsrf = ""
# What seed_cookies_from_env() last read from disk — used to detect a .env refresh.
_last_seeded_aspx = ""
_last_seeded_csrf = ""


def _client() -> httpx.AsyncClient:
    """A fresh client per request (no cookie persistence inside httpx).

    fetch() follows redirects by default, so this does too. Tests replace this
    factory to inject an ``httpx.MockTransport``.
    """
    return httpx.AsyncClient(follow_redirects=True, timeout=_TIMEOUT)


def _cookie_header() -> str:
    return "; ".join(f"{k}={v}" for k, v in _cookie_jar.items())


def _store_set_cookies(res: httpx.Response) -> None:
    """Store every Set-Cookie header (name=value only) in the module jar."""
    global _bpmcsrf
    for line in res.headers.get_list("set-cookie"):
        first = line.split(";")[0]
        name, sep, value = first.partition("=")
        if not sep:
            continue
        name, value = name.strip(), value.strip()
        _cookie_jar[name] = value
        if name == "BPMCSRF":
            _bpmcsrf = value


# Public alias under the TS name, for callers/tests.
store_set_cookies = _store_set_cookies


def seed_cookies_from_env() -> None:
    """Seed the cookie jar from the `.env` file (SSO cookie mode), reading the
    freshest values from disk on every call so a refresh is picked up live."""
    global _cookie_jar, _bpmcsrf, _last_seeded_aspx, _last_seeded_csrf
    c = resolve_cookie_env()
    _cookie_jar = {".ASPXAUTH": c["aspx"], "BPMCSRF": c["csrf"]}
    if c["loader"]:
        _cookie_jar["BPMLOADER"] = c["loader"]
    _bpmcsrf = c["csrf"]
    _last_seeded_aspx = c["aspx"]
    _last_seeded_csrf = c["csrf"]


class AuthError(Exception):
    """Raised when SSO cookies are missing/expired. Consumers can special-case
    it (the web app maps it to an "open Settings" banner)."""


def _js_str(v: Any) -> str:
    """String(v) the way JS would print a JSON value in a template literal."""
    if v is None:
        return "null"
    if v is True:
        return "true"
    if v is False:
        return "false"
    if isinstance(v, float) and v.is_integer():
        return str(int(v))
    return str(v)


async def login() -> None:
    global _cookie_jar, _bpmcsrf
    if not BASE_URL:
        raise ValueError(
            "Creatio base URL is not configured (CREATIO_BASE_URL). Set it in Settings / .env."
        )

    # Cookie mode can't re-authenticate against Creatio (the cookies came from a
    # browser session), but the cookies live in .env — so on expiry we re-read
    # the file: if you've refreshed it, we pick up the new cookies and carry on;
    # if it's unchanged, we report the clear error. No restart needed either way.
    # Decide cookie-vs-forms mode from what is on disk RIGHT NOW rather than from
    # the import-time COOKIE_MODE. The app's browser login writes cookies into a
    # .env that may have had none when the server started; that has to take
    # effect without a restart, or we would fall through to forms auth (with
    # empty credentials) and fail even though valid cookies are sitting on disk.
    fresh = resolve_cookie_env()
    if fresh["aspx"] and fresh["csrf"]:
        changed = fresh["aspx"] != _last_seeded_aspx or fresh["csrf"] != _last_seeded_csrf
        if _bpmcsrf and not changed:
            raise AuthError(
                "Creatio session cookies have expired. Grab fresh .ASPXAUTH / BPMCSRF / BPMLOADER "
                "from your browser (DevTools → Application → Cookies) and update your .env. "
                "The server re-reads .env automatically — no restart needed."
            )
        seed_cookies_from_env()
        return

    _cookie_jar = {}
    _bpmcsrf = ""
    async with _client() as client:
        res = await client.post(
            f"{BASE_URL}/ServiceModel/AuthService.svc/Login",
            headers={"Content-Type": "application/json", "Accept": "application/json"},
            content=json.dumps({"UserName": _LOGIN, "UserPassword": _PASSWORD}),
        )
    _store_set_cookies(res)
    try:
        body = res.json()
    except Exception:
        body = {}
    if not isinstance(body, dict):
        body = {}
    if not res.is_success or ("Code" in body and body["Code"] != 0):
        code = _js_str(body["Code"]) if "Code" in body else "undefined"
        msg = body.get("Message")
        raise RuntimeError(
            f"Creatio login failed (Code={code}): {msg if msg is not None else res.reason_phrase}"
        )
    if not _bpmcsrf:
        raise RuntimeError("Creatio login succeeded but no BPMCSRF cookie was returned.")


def _session_headers(accept: str) -> dict[str, str]:
    return {
        "Accept": accept,
        "Cookie": _cookie_header(),
        "BPMCSRF": _bpmcsrf,
        "ForceUseSession": "true",
    }


async def odata_get(path: str) -> Any:
    """The ONLY OData call path. Method is hard-coded to GET."""
    if not _bpmcsrf:
        await login()

    url = f"{BASE_URL}/0/odata/{path}"
    async with _client() as client:
        res = await client.get(url, headers=_session_headers("application/json"))
        if res.status_code in (401, 403):
            # Session expired — re-auth (or re-read refreshed cookies) once and retry.
            await login()
            res = await client.get(url, headers=_session_headers("application/json"))

    text = res.text
    if res.status_code in (401, 403):
        raise AuthError(
            f"Creatio rejected the session (HTTP {res.status_code}). "
            "The cookies are expired or invalid — update them in Settings / .env."
        )
    if not res.is_success:
        raise RuntimeError(
            f"OData GET /{path} -> {res.status_code} {res.reason_phrase}: {text[:500]}"
        )
    return json.loads(text) if text else {}


_FILENAME_RE = re.compile(r"""filename\*?=(?:UTF-8'')?"?([^";]+)"?""", re.I)


async def download_file(entity: str, id: str) -> dict[str, Any]:
    """Download an attachment (read-only GET) from Creatio's FileService, e.g.
    /0/rest/FileService/Download/CaseFile/<guid>. Restricted to the file-entity
    allowlist + a GUID id so it can't be aimed at arbitrary paths.

    Returns ``{"buffer": bytes, "contentType": str, "filename"?: str}``.
    """
    if entity not in FILE_DOWNLOAD_ENTITIES:
        raise ValueError(f'File entity "{entity}" is not downloadable.')
    if not isinstance(id, str) or not _GUID_RE.fullmatch(id):
        raise ValueError(f"Invalid file id: {id}")
    if not BASE_URL:
        raise ValueError("Creatio base URL is not configured.")
    if not _bpmcsrf:
        await login()

    url = f"{BASE_URL}/0/rest/FileService/Download/{entity}/{id}"
    async with _client() as client:
        res = await client.get(url, headers=_session_headers("*/*"))
        if res.status_code in (401, 403):
            await login()
            res = await client.get(url, headers=_session_headers("*/*"))
    if res.status_code in (401, 403):
        raise AuthError(
            f"Creatio rejected the session (HTTP {res.status_code}) while downloading a file."
        )
    if not res.is_success:
        raise RuntimeError(
            f"File download {entity}/{id} -> {res.status_code} {res.reason_phrase}"
        )
    content_type = res.headers.get("content-type") or "application/octet-stream"
    cd = res.headers.get("content-disposition") or ""
    m = _FILENAME_RE.search(cd)
    out: dict[str, Any] = {"buffer": res.content, "contentType": content_type}
    if m:
        out["filename"] = m.group(1)
    return out


# ---------------------------------------------------------------------------
# OData query builder (read-only)
# ---------------------------------------------------------------------------
def _form_encode(s: str) -> str:
    """application/x-www-form-urlencoded, byte-for-byte like JS URLSearchParams.

    URLSearchParams leaves only ASCII alphanumerics and ``*-._`` unencoded and
    turns spaces into ``+``. quote_plus additionally keeps ``~``, so encode it.
    """
    return quote_plus(s, safe="*").replace("~", "%7E")


def _top_str(top: Any) -> str:
    # Mirrors JS String(n) feeding parseInt: 5.7 -> "5", missing -> default.
    if isinstance(top, bool):
        return ""
    if isinstance(top, float):
        return str(int(top)) if top == top and abs(top) != float("inf") else ""
    return str(top)


def build_query(opts: Mapping[str, Any] | None = None, **kw: Any) -> str:
    """Build ``?$select=...&$filter=...&$orderby=...&$expand=...&$top=N``.

    Options (dict or keywords): select (list[str]), filter, orderby, top, expand.
    ``$top`` is always present and clamped to 1..MAX_TOP.
    """
    o = {**(opts or {}), **kw}
    params: list[tuple[str, str]] = []
    if o.get("select"):
        params.append(("$select", ",".join(o["select"])))
    if o.get("filter"):
        params.append(("$filter", o["filter"]))
    if o.get("orderby"):
        params.append(("$orderby", o["orderby"]))
    if o.get("expand"):
        params.append(("$expand", o["expand"]))
    top = o.get("top")
    params.append(("$top", str(clamp_int(_top_str(MAX_TOP if top is None else top), MAX_TOP, 1, MAX_TOP))))
    s = "&".join(f"{_form_encode(k)}={_form_encode(v)}" for k, v in params)
    return f"?{s}" if s else ""


async def query_records(
    entity: str, opts: Mapping[str, Any] | None = None, **kw: Any
) -> list[Any]:
    """Convenience: query an entity set with the standard options. Returns the
    OData ``value`` array (or ``[]`` if absent)."""
    assert_entity_allowed(entity)
    data = await odata_get(entity + build_query(opts, **kw))
    return (data.get("value") if isinstance(data, dict) else None) or []


def connection_probe_path() -> str:
    """The OData path the connection check probes: one primary key from the
    first allowed entity. Public so the "always narrow $select" contract is
    testable without a network call.

    $select is deliberately narrowed to Id. An unqualified read asks Creatio to
    serialize EVERY column of the entity, so a single column that fails to
    serialize answers with "HTTP 500 ObjectContent`1 type failed to serialize"
    even on a perfectly valid session — which the Settings screen then reports
    as a credentials problem. One primary key tests exactly what this check is
    for: session validity and reachability.
    """
    entity = ALLOWED_ENTITIES[0] if ALLOWED_ENTITIES else "Contact"
    return entity + build_query(select=["Id"], top=1)


def _msg(e: BaseException) -> str:
    return str(e) or type(e).__name__


def describe_error(e: object) -> str:
    """httpx often reports transport failures with a terse message. Dig the
    real cause out of the exception chain (``__cause__`` / ``__context__``:
    connection resets, DNS failures, cert errors, connect timeouts) so the UI
    can show something actionable instead."""
    if not isinstance(e, BaseException):
        return str(e)
    top = _msg(e)
    parts: list[str] = []
    cur = e.__cause__ or e.__context__
    i = 0
    while cur is not None and i < 5:
        code = getattr(cur, "code", None)
        bit = code if isinstance(code, str) and code else _msg(cur)
        if bit and bit != top and bit not in parts:
            parts.append(bit)
        cur = cur.__cause__ or cur.__context__
        i += 1
    return f"{top} ({' → '.join(parts)})" if parts else top


async def test_connection() -> dict[str, Any]:
    """Lightweight auth/connectivity check — reads 1 row of the first allowed
    entity (or Contact). Returns ``{"ok": True}`` or ``{"ok": False, "error"}``."""
    try:
        await odata_get(connection_probe_path())
        return {"ok": True}
    except Exception as e:  # noqa: BLE001 — surfaced to the UI as text
        return {"ok": False, "error": describe_error(e)}


# pytest would otherwise collect this coroutine function as a test when a test
# module does `from creatio_case_lookup.creatio_client import *`-style imports.
test_connection.__test__ = False  # type: ignore[attr-defined]
