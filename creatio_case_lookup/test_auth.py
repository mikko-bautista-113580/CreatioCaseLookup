"""Standalone auth check. Verifies the credentials in your `.env` actually
work, WITHOUT starting the MCP server.

 - Forms mode (CREATIO_LOGIN/PASSWORD): runs the AuthService.svc/Login call.
 - Cookie mode (CREATIO_ASPXAUTH/BPMCSRF): does a tiny read-only OData GET to
   confirm the pasted browser session is still valid.

    creatio-test-auth        (or: python -m creatio_case_lookup.test_auth)

Exit code 0 = works, 1 = doesn't (or config is missing).

Reads the process environment, with `.env` loaded underneath it by env.py
(values already in the environment win, like `node --env-file`).
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import sys

import httpx

from . import env as _env  # noqa: F401 — importing loads .env into os.environ

_TIMEOUT = httpx.Timeout(120.0, connect=30.0)


def _err(msg: str) -> None:
    print(msg, file=sys.stderr)


def _require_env(name: str) -> str:
    v = os.environ.get(name)
    if not v:
        _err(f"✖ Missing required env var: {name}")
        _err("  Copy .env.example to .env and fill it in.")
        sys.exit(1)
    return v


async def _test_cookies(base_url: str, aspx: str, csrf: str, loader: str) -> int:
    entity = (os.environ.get("CREATIO_ALLOWED_ENTITIES") or "").split(",")[0].strip() or "Contact"
    _err(f"→ Cookie mode: validating session against {base_url} (reading 1 {entity}) ...")

    cookie = "; ".join(
        c for c in (f".ASPXAUTH={aspx}", f"BPMCSRF={csrf}", f"BPMLOADER={loader}" if loader else "") if c
    )

    try:
        # $select=Id keeps this a pure session check: an unqualified read makes
        # Creatio serialize every column, so one column that fails to serialize
        # returns a 500 that would be mistaken for an auth problem.
        async with httpx.AsyncClient(follow_redirects=True, timeout=_TIMEOUT) as client:
            res = await client.get(
                f"{base_url}/0/odata/{entity}?$top=1&$select=Id",
                headers={
                    "Accept": "application/json",
                    "Cookie": cookie,
                    "BPMCSRF": csrf,
                    "ForceUseSession": "true",
                },
            )
    except Exception as e:  # noqa: BLE001
        _err(f"✖ Could not reach Creatio: {e}")
        _err("  Check CREATIO_BASE_URL and your network/VPN.")
        return 1

    if res.is_success:
        _err("✔ Success. The session cookies are valid — the MCP server can read with them.")
        _err("  Reminder: these expire; re-grab from DevTools when reads start failing.")
        return 0

    if res.status_code in (401, 403):
        _err(f"✖ Cookies rejected (HTTP {res.status_code}). The session is expired or invalid.")
        _err(f"  Log into {base_url} again, re-copy .ASPXAUTH / BPMCSRF / BPMLOADER from")
        _err("  DevTools → Application → Cookies, and update .env.")
    else:
        try:
            text = res.text
        except Exception:  # noqa: BLE001
            text = ""
        _err(f"✖ Unexpected HTTP {res.status_code} {res.reason_phrase}: {text[:300]}")
    return 1


def _js(v: object) -> str:
    if v is True:
        return "true"
    if v is False:
        return "false"
    return str(v)


async def _test_forms_login(base_url: str) -> int:
    login = _require_env("CREATIO_LOGIN")
    password = _require_env("CREATIO_PASSWORD")
    _err(f'→ Forms mode: logging in as "{login}" at {base_url} ...')

    try:
        async with httpx.AsyncClient(follow_redirects=True, timeout=_TIMEOUT) as client:
            res = await client.post(
                f"{base_url}/ServiceModel/AuthService.svc/Login",
                headers={"Content-Type": "application/json", "Accept": "application/json"},
                content=json.dumps({"UserName": login, "UserPassword": password}),
            )
    except Exception as e:  # noqa: BLE001
        _err(f"✖ Could not reach Creatio: {e}")
        _err("  Check CREATIO_BASE_URL and your network/VPN.")
        return 1

    try:
        body = res.json()
    except Exception:  # noqa: BLE001
        body = {}
    if not isinstance(body, dict):
        body = {}
    got_bpmcsrf = any(c.startswith("BPMCSRF=") for c in res.headers.get_list("set-cookie"))
    code = body.get("Code")

    if res.is_success and code == 0 and code is not False and got_bpmcsrf:
        _err("✔ Success. Forms auth works and a BPMCSRF cookie was issued.")
        return 0

    _err(f"✖ Login failed. HTTP {res.status_code} {res.reason_phrase}")
    msg = body.get("Message")
    _err(
        f"  Code: {_js(code) if code is not None else '(none)'}  "
        f"Message: {_js(msg) if msg is not None else '(none)'}"
    )
    if code and code != 0:
        _err("  This usually means wrong credentials, OR the account is SSO-only /")
        _err("  forms login is disabled. If so, use cookie mode instead.")
    return 1


def main() -> None:
    # The messages use ✔ ✖ → — ; a legacy Windows console codepage can't encode them.
    try:
        sys.stderr.reconfigure(encoding="utf-8")  # type: ignore[union-attr]
    except (AttributeError, ValueError):
        pass

    base_url = re.sub(r"/+$", "", _require_env("CREATIO_BASE_URL"))
    aspx = re.sub(r"^\.?ASPXAUTH=", "", (os.environ.get("CREATIO_ASPXAUTH") or "").strip(), flags=re.I)
    csrf = re.sub(r"^BPMCSRF=", "", (os.environ.get("CREATIO_BPMCSRF") or "").strip(), flags=re.I)
    loader = re.sub(r"^BPMLOADER=", "", (os.environ.get("CREATIO_BPMLOADER") or "").strip(), flags=re.I)
    cookie_mode = bool(aspx and csrf)

    if cookie_mode:
        code = asyncio.run(_test_cookies(base_url, aspx, csrf, loader))
    else:
        code = asyncio.run(_test_forms_login(base_url))
    sys.exit(code)


if __name__ == "__main__":
    main()
