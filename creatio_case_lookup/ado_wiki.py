"""Read-only client for the team's Azure DevOps wiki.

The Custom Team wiki (renweb / Custom Development / Custom-Team.wiki by
default) holds the team's standards: report-card variables, integration
setup guides, quoting and testing policy, SQL and ColdFusion snippets. A
case-scoped analysis pulls the few pages that match the case so the fix is
checked against how the team actually does things.

AUTH: the user's existing Azure CLI login. `az account get-access-token` for
the Azure DevOps resource gives a short-lived bearer token; nothing is stored
on disk and the token is never logged or sent anywhere but dev.azure.com.
The az argv is fixed and app-authored — no user or case text reaches it, and
it is exec'd directly (no shell).

FAILURE IS NOT FATAL: every caller treats WikiUnavailable as "analyze without
wiki references" and records why as a caveat. A missing `az`, an expired
login or a network blip must never block the analysis itself.

CACHE: `.analysis/wiki/` (git-ignored). The page tree and each page's content
are reused for 24h — the wiki changes slowly, and a case run shouldn't spend
its time re-downloading it. Same files as the TypeScript build, so the two
share a cache.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any, Awaitable, Callable
from urllib.parse import quote

import httpx

from .env import read_env_file
from .workspace import ANALYSIS_DIR, iso_now, js_parse_int, now_ms, parse_iso_ms, write_atomic

# The Azure DevOps resource id — fixed for every ADO organization.
ADO_RESOURCE = "499b84ac-1321-427f-aa17-267ca6975798"

WIKI_DIR = Path(ANALYSIS_DIR) / "wiki"
TREE_PATH = WIKI_DIR / "tree.json"
PAGES_DIR = WIKI_DIR / "pages"

CACHE_MS = 24 * 3_600_000
AZ_TIMEOUT_S = 30
HTTP_TIMEOUT_S = 20

# WikiFailure: "disabled" | "az-missing" | "not-logged-in" | "http"


class WikiUnavailable(Exception):
    def __init__(self, message: str, reason: str):
        super().__init__(message)
        self.reason = reason

    @property
    def message(self) -> str:
        return str(self)


def wiki_config() -> dict:
    """{org, project, wiki, enabled, maxPages} — read live from .env."""
    env = read_env_file()
    n = js_parse_int((env.get("CREATIO_WIKI_MAX_PAGES") or "").strip())
    return {
        "org": (env.get("ADO_WIKI_ORG") or "renweb").strip(),
        "project": (env.get("ADO_WIKI_PROJECT") or "Custom Development").strip(),
        "wiki": (env.get("ADO_WIKI_ID") or "Custom-Team.wiki").strip(),
        "enabled": not re.fullmatch(r"(0|false|no|off)", (env.get("CREATIO_WIKI_ENABLED") or "").strip(), re.IGNORECASE),
        "maxPages": 4 if n is None else max(1, min(10, n)),
    }


def _enc(s: str) -> str:
    """``encodeURIComponent``."""
    return quote(str(s), safe="-_.!~*'()")


def _api_base(c: dict) -> str:
    return f"https://dev.azure.com/{_enc(c['org'])}/{_enc(c['project'])}/_apis/wiki/wikis/{_enc(c['wiki'])}/pages"


def page_url(c: dict, path: str, id: int | None = None) -> str:
    """Browser link for a page — what the UI and the reports show."""
    base = f"https://dev.azure.com/{_enc(c['org'])}/{_enc(c['project'])}/_wiki/wikis/{_enc(c['wiki'])}"
    if id:
        return f"{base}/{id}"
    return f"{base}?pagePath={_enc(path)}"


# ---------------------------------------------------------------------------
# Token
# ---------------------------------------------------------------------------

# An AzRunner takes the argv (without "az") and returns {code, stdout, stderr}.
AzRunner = Callable[[list[str]], Awaitable[dict]]

_SAFE_ARG = re.compile(r"[\w.:-]+", re.ASCII)


async def _default_az_runner(args: list[str]) -> dict:
    """Run the Azure CLI with a fixed argv and no shell.

    `shutil.which("az")` resolves the `az.cmd` shim on Windows; CreateProcess
    runs a .cmd path directly. The metacharacter guard is kept anyway: cmd.exe
    still parses a batch file's arguments, so every token must be plain.
    """
    if any(not _SAFE_ARG.fullmatch(a) for a in args):
        return {"code": 2, "stdout": "", "stderr": "Refusing an az argument with shell metacharacters."}
    exe = shutil.which("az")
    if not exe:
        return {"code": 127, "stdout": "", "stderr": "spawn az ENOENT"}
    kwargs: dict[str, Any] = {}
    if sys.platform == "win32":
        kwargs["creationflags"] = subprocess.CREATE_NO_WINDOW  # windowsHide
    try:
        proc = await asyncio.create_subprocess_exec(
            exe,
            *args,
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            **kwargs,
        )
    except OSError as e:
        return {"code": 127, "stdout": "", "stderr": str(e)}
    try:
        out, err = await asyncio.wait_for(proc.communicate(), AZ_TIMEOUT_S)
    except asyncio.TimeoutError:
        try:
            proc.kill()
        except ProcessLookupError:
            pass
        await proc.wait()
        return {"code": 1, "stdout": "", "stderr": "az timed out"}
    return {
        "code": proc.returncode if proc.returncode is not None else 1,
        "stdout": out.decode("utf-8", errors="replace"),
        "stderr": err.decode("utf-8", errors="replace"),
    }


_az_runner: AzRunner = _default_az_runner
_cached: dict | None = None


def set_az_runner(r: AzRunner | None) -> None:
    """Test seam: swap the az runner and drop the cached token."""
    global _az_runner, _cached
    _az_runner = r or _default_az_runner
    _cached = None


def parse_token_output(stdout: str) -> dict:
    """Parse `az account get-access-token -o json` output → {token, expires (epoch ms)}.
    Exported for tests."""
    try:
        o = json.loads(stdout)
    except (ValueError, TypeError):
        raise WikiUnavailable("The Azure CLI returned something that isn't a token.", "not-logged-in") from None
    if not isinstance(o, dict):
        o = {}
    token = o.get("accessToken") if isinstance(o.get("accessToken"), str) else ""
    if not token:
        raise WikiUnavailable("The Azure CLI returned no access token.", "not-logged-in")
    # `expires_on` (epoch seconds) is present on newer CLIs; `expiresOn` is a
    # local-time string on all of them.
    eo = o.get("expires_on")
    expires: float | None = eo * 1000 if isinstance(eo, (int, float)) and not isinstance(eo, bool) else None
    if expires is None and isinstance(o.get("expiresOn"), str):
        expires = parse_iso_ms(o["expiresOn"])
    if expires is None:
        expires = now_ms() + 30 * 60_000
    return {"token": token, "expires": expires}


async def get_token() -> str:
    global _cached
    if _cached and _cached["expires"] - 5 * 60_000 > now_ms():
        return _cached["token"]
    r = await _az_runner(["account", "get-access-token", "--resource", ADO_RESOURCE, "-o", "json"])
    if r.get("code") != 0:
        err = r.get("stderr") or ""
        if r.get("code") == 127 or re.search(r"not recognized|not found|ENOENT", err, re.IGNORECASE):
            raise WikiUnavailable(
                "The Azure CLI (az) isn't installed, so the team wiki was skipped. Install it and run `az login`.",
                "az-missing",
            )
        raise WikiUnavailable(
            "The Azure CLI isn't logged in (or the login expired), so the team wiki was skipped. Run `az login`.",
            "not-logged-in",
        )
    _cached = parse_token_output(r.get("stdout") or "")
    return _cached["token"]


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------


async def _ado_get(url: str, label: str = "team wiki") -> dict:
    """GET an Azure DevOps API URL → {json, etag}. `label` names the thing being
    read in error messages ("team wiki", "team skills repo")."""
    global _cached
    token = await get_token()
    try:
        async with httpx.AsyncClient(timeout=HTTP_TIMEOUT_S) as client:
            res = await client.get(url, headers={"Authorization": f"Bearer {token}", "Accept": "application/json"})
    except httpx.HTTPError as e:
        raise WikiUnavailable(f"The {label} couldn't be reached ({str(e) or type(e).__name__}).", "http") from None
    if res.status_code in (401, 403):
        _cached = None
        raise WikiUnavailable(
            f"Azure DevOps refused the Azure CLI login for the {label}. Run `az login` with an account that can read it.",
            "not-logged-in",
        )
    if not (200 <= res.status_code < 300):
        raise WikiUnavailable(f"The {label} returned HTTP {res.status_code}.", "http")
    return {"json": res.json(), "etag": res.headers.get("etag") or ""}


# ---------------------------------------------------------------------------
# Tree + pages
#
# WikiPageInfo: {path, id?, section} — `section` means it has sub-pages.
# WikiPage:     {path, id?, url, content}
# ---------------------------------------------------------------------------


def _is_num(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def flatten_tree(node: Any) -> list[dict]:
    """Flatten the ADO page tree, dropping the root and image folders. Exported for tests."""
    out: list[dict] = []

    def walk(n: Any) -> None:
        if not isinstance(n, dict) or not isinstance(n.get("path"), str):
            return
        path = n["path"]
        if re.search(r"/\.[^/]*\Z", path) or "/." in path:
            return  # .images, .attachments
        subs = n.get("subPages") if isinstance(n.get("subPages"), list) else []
        if path != "/":
            row: dict = {"path": path}
            if _is_num(n.get("id")):
                row["id"] = n["id"]
            row["section"] = len(subs) > 0
            out.append(row)
        for s in subs:
            walk(s)

    walk(node)
    return out


def _fresh(iso: Any) -> bool:
    t = parse_iso_ms(iso or "")
    return t is not None and now_ms() - t < CACHE_MS


def _dump(obj: Any) -> str:
    return json.dumps(obj, indent=2, ensure_ascii=False)


async def get_wiki_tree(refresh: bool = False) -> list[dict]:
    c = wiki_config()
    if not c["enabled"]:
        raise WikiUnavailable("Team wiki lookup is turned off (CREATIO_WIKI_ENABLED).", "disabled")
    key = f"{c['org']}/{c['project']}/{c['wiki']}"
    if not refresh:
        try:
            with open(TREE_PATH, encoding="utf-8") as f:
                doc = json.load(f)
            if doc.get("wiki") == key and _fresh(doc.get("fetchedAt")) and isinstance(doc.get("pages"), list):
                return doc["pages"]
        except (OSError, ValueError, AttributeError):
            pass  # no cache yet
    got = await _ado_get(f"{_api_base(c)}?path=/&recursionLevel=Full&api-version=7.1")
    pages = flatten_tree(got["json"])
    doc = {"fetchedAt": iso_now(), "wiki": key, "pages": pages}
    write_atomic(TREE_PATH, _dump(doc))
    return pages


def _page_cache_path(key: str) -> Path:
    return Path(PAGES_DIR) / (hashlib.sha1(key.encode("utf-8")).hexdigest()[:16] + ".json")


def clean_page_content(md: str) -> str:
    """Tidy page Markdown for a prompt: drop image embeds (the analysis can't see
    them and they're pure noise), keep links and text."""
    s = str(md or "")
    s = re.sub(r"!\[[^\]]*\]\([^)]*\)", "", s)
    s = re.sub(r"<img\b[^>]*>", "", s, flags=re.IGNORECASE)
    s = re.sub(r"\n{3,}", "\n\n", s)
    return s.strip(" \t\n\x0b\x0c\r ﻿  　")


async def get_wiki_page(path: str, refresh: bool = False) -> dict:
    c = wiki_config()
    if not c["enabled"]:
        raise WikiUnavailable("Team wiki lookup is turned off (CREATIO_WIKI_ENABLED).", "disabled")
    key = f"{c['org']}/{c['project']}/{c['wiki']}|{path}"
    file = _page_cache_path(key)
    if not refresh:
        try:
            with open(file, encoding="utf-8") as f:
                doc = json.load(f)
            if doc.get("key") == key and _fresh(doc.get("fetchedAt")):
                return doc["page"]
        except (OSError, ValueError, AttributeError, KeyError):
            pass  # not cached
    got = await _ado_get(f"{_api_base(c)}?path={_enc(path)}&includeContent=true&api-version=7.1")
    j = got["json"] if isinstance(got["json"], dict) else {}
    page_id = j.get("id") if _is_num(j.get("id")) else None
    page: dict = {"path": j["path"] if isinstance(j.get("path"), str) else path}
    if page_id is not None:
        page["id"] = page_id
    page["url"] = page_url(c, path, page_id)
    page["content"] = clean_page_content(j.get("content") or "")
    write_atomic(file, _dump({"key": key, "fetchedAt": iso_now(), "page": page}))
    return page


async def test_wiki() -> dict:
    """Settings-tab probe: can we log in and list the wiki? → {ok, pages?, message, reason?}"""
    try:
        pages = await get_wiki_tree(refresh=True)
        c = wiki_config()
        return {"ok": True, "pages": len(pages), "message": f"Connected to {c['wiki']} — {len(pages)} pages."}
    except WikiUnavailable as e:
        return {"ok": False, "message": str(e), "reason": e.reason}
    except Exception as e:  # noqa: BLE001 — surfaced to the UI verbatim
        return {"ok": False, "message": str(e), "reason": "http"}


# pytest would otherwise collect `test_wiki` if this module were imported into a test namespace.
test_wiki.__test__ = False  # type: ignore[attr-defined]
