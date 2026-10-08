"""Who a Creatio session belongs to.

Used by the sign-in gate (to find which developer is logging in) and by the
app (to show the signed-in user's own name in the "e.g. …" name placeholders,
saved to `.env` as ``CREATIO_USER_NAME``). Read-only: one user-info call, then
the contact's name and email via OData.
"""

from __future__ import annotations

import json
import re
from typing import Any

import httpx

from .env import write_env_file

USER_NAME_KEY = "CREATIO_USER_NAME"
_GUID_RE = re.compile(r"^[0-9a-fA-F-]{36}$")


def identity_fields(data: Any, depth: int = 0) -> dict[str, str]:
    """Pull contact id / name / login / email out of a Creatio user-info reply,
    whatever its nesting (some replies wrap a JSON string in a ``...Result``)."""
    keys = {"contactid": "contactId", "contactname": "name", "username": "login", "login": "login",
            "email": "email"}
    out: dict[str, str] = {}
    if depth > 4:
        return out
    if isinstance(data, str):
        try:
            data = json.loads(data)
        except ValueError:
            return out
    if isinstance(data, dict):
        for k, v in data.items():
            key = keys.get(str(k).lower())
            if key and isinstance(v, str) and v.strip() and key not in out:
                out[key] = v.strip()
            elif isinstance(v, (dict, list, str)):
                for kk, vv in identity_fields(v, depth + 1).items():
                    out.setdefault(kk, vv)
    elif isinstance(data, list):
        for item in data[:3]:
            for kk, vv in identity_fields(item, depth + 1).items():
                out.setdefault(kk, vv)
    return out


async def creatio_identity(base_url: str, cookies: dict[str, str], timeout_s: float = 30) -> dict[str, str]:
    """``{"contactId", "name", "login", "email"}`` (whatever Creatio reveals) for
    the session in ``cookies`` (``aspx`` / ``csrf`` / optional ``loader``)."""
    jar = f".ASPXAUTH={cookies['aspx']}; BPMCSRF={cookies['csrf']}"
    if cookies.get("loader"):
        jar += f"; BPMLOADER={cookies['loader']}"
    headers = {"Accept": "application/json", "Content-Type": "application/json", "Cookie": jar,
               "BPMCSRF": cookies["csrf"], "ForceUseSession": "true"}
    who: dict[str, str] = {}
    async with httpx.AsyncClient(follow_redirects=True, timeout=timeout_s) as c:
        try:
            r = await c.post(f"{base_url}/0/ServiceModel/UserInfoService.svc/getCurrentUserInfo",
                             headers=headers, content="{}")
            if r.is_success:
                who = identity_fields(r.json())
        except (httpx.HTTPError, ValueError):
            pass
        cid = who.get("contactId", "")
        if _GUID_RE.match(cid):
            try:
                r = await c.get(f"{base_url}/0/odata/Contact({cid})?$select=Name,Email", headers=headers)
                if r.is_success:
                    j = r.json()
                    if j.get("Email"):
                        who["email"] = j["Email"].strip()
                    if j.get("Name"):
                        who["name"] = j["Name"].strip()
            except (httpx.HTTPError, ValueError):
                pass
    return {k: v for k, v in who.items() if v}


async def remember_user_name(base_url: str, cookies: dict[str, str]) -> str:
    """Look up the session's user and save their name for the placeholders.
    Best effort: "" (and nothing saved) when Creatio doesn't say."""
    if not (base_url and cookies.get("aspx") and cookies.get("csrf")):
        return ""
    try:
        name = (await creatio_identity(base_url, cookies, timeout_s=15)).get("name", "")
    except Exception:  # noqa: BLE001 — only a placeholder name
        return ""
    if name:
        write_env_file({USER_NAME_KEY: name})
    return name
