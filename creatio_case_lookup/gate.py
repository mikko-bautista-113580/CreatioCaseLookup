"""Shared sign-in gate: works out who someone is from their Creatio login.

In Azure there is one URL for everyone and one private app per developer. The
front router sends anyone without a valid identity cookie here. This page:

1. Runs the usual "Log in with Creatio…" browser login (Chrome on the
   container's virtual display, seen through the viewer tab) with a fresh,
   throwaway browser profile, so nobody inherits the previous person's session.
2. Asks Creatio whose session it is, falling back to the Microsoft account
   typed during Creatio's Azure SSO.
3. Matches that to a developer (``GATE_DEVELOPERS``), hands the Creatio session
   cookies to that developer's own app, and sets the ``ccl_id`` cookie the
   router checks (nginx ``secure_link``: base64url MD5 of
   ``"<expires>:<name>:<secret>"``), so later visits go straight to their app.

Run with ``uvicorn creatio_case_lookup.gate:app`` (the container entrypoint does
this when ``CCL_GATE=1``). One sign-in at a time; only the person signing in can
connect to the viewer (``/_gate/viewer-ok`` is nginx's auth_request check).

Config (env): ``GATE_DEVELOPERS`` JSON ``{"name": ["email", ...]}``,
``GATE_SECRET``, ``BACKEND_PREFIX`` / ``BACKEND_SUFFIX`` (developer app host =
prefix + name + suffix), ``CREATIO_BASE_URL``, optional ``GATE_ID_DAYS``.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import os
import re
import secrets
import shutil
import tempfile
import time
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs

import httpx
from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse, Response, StreamingResponse

ID_COOKIE = "ccl_id"
VIEWER_COOKIE = "ccl_gate"
TICKET_TTL_S = 120
_GUID_RE = re.compile(r"^[0-9a-fA-F-]{36}$")

app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)

_lock = asyncio.Lock()
_active_viewer: str | None = None  # VIEWER_COOKIE of the person signing in right now
_tickets: dict[str, tuple[str, float]] = {}  # one-time ticket → (developer, expires)


# ---------------------------------------------------------------------------
# Config, identity cookie
# ---------------------------------------------------------------------------
def developers() -> dict[str, set[str]]:
    raw = json.loads(os.environ.get("GATE_DEVELOPERS") or "{}")
    out: dict[str, set[str]] = {}
    for name, ids in raw.items():
        ids = [ids] if isinstance(ids, str) else ids
        out[name] = {str(i).strip().lower() for i in ids if str(i).strip()}
    return out


def _secret() -> str:
    s = os.environ.get("GATE_SECRET", "")
    if len(s) < 16:
        raise RuntimeError("GATE_SECRET is not set.")
    return s


def sign(name: str, expires: int) -> str:
    """What nginx's secure_link_md5 "$exp:$name:<secret>" expects: base64url MD5, no padding."""
    digest = hashlib.md5(f"{expires}:{name}:{_secret()}".encode()).digest()  # noqa: S324 — nginx secure_link format
    return base64.urlsafe_b64encode(digest).decode().rstrip("=")


def id_cookie(name: str, now: float | None = None) -> tuple[str, int]:
    days = int(os.environ.get("GATE_ID_DAYS") or 7)
    max_age = days * 86400
    expires = int(now if now is not None else time.time()) + max_age
    return f"{name}.{expires}.{sign(name, expires)}", max_age


# ---------------------------------------------------------------------------
# Who is this? (Creatio first, then the Microsoft account typed at SSO)
# ---------------------------------------------------------------------------
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


async def creatio_identity(base_url: str, cookies: dict[str, str]) -> dict[str, str]:
    jar = f".ASPXAUTH={cookies['aspx']}; BPMCSRF={cookies['csrf']}"
    if cookies.get("loader"):
        jar += f"; BPMLOADER={cookies['loader']}"
    headers = {"Accept": "application/json", "Content-Type": "application/json", "Cookie": jar,
               "BPMCSRF": cookies["csrf"], "ForceUseSession": "true"}
    who: dict[str, str] = {}
    async with httpx.AsyncClient(follow_redirects=True, timeout=30) as c:
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
                    who.setdefault("name", (j.get("Name") or "").strip())
            except (httpx.HTTPError, ValueError):
                pass
    return {k: v for k, v in who.items() if v}


def microsoft_logins(request: Any) -> list[str]:
    """The account typed on Microsoft's sign-in page during Creatio's Azure SSO."""
    try:
        if request.method != "POST" or "login.microsoftonline.com" not in request.url:
            return []
        form = parse_qs(request.post_data or "")
    except Exception:  # noqa: BLE001 — never break the login over this
        return []
    return [v.strip().lower() for k in ("login", "loginfmt", "username") for v in form.get(k, []) if "@" in v]


def match(who: dict[str, str], ms: list[str]) -> str | None:
    creatio_ids = {who[k].lower() for k in ("email", "login") if who.get(k)}
    devs = developers()
    for ids in (creatio_ids, set(ms)):  # Creatio's answer wins; Microsoft account is the fallback
        for name, known in devs.items():
            if ids & known:
                return name
    return None


async def hand_off(name: str, cookies: dict[str, str]) -> dict[str, Any]:
    """Give the Creatio session to that developer's own app (same call as its Settings → Save)."""
    host = f"{os.environ.get('BACKEND_PREFIX', '')}{name}{os.environ.get('BACKEND_SUFFIX', '')}"
    body = {"aspx": cookies["aspx"], "csrf": cookies["csrf"]}
    if cookies.get("loader"):
        body["loader"] = cookies["loader"]
    # A scaled-to-zero app needs a minute or two to start
    async with httpx.AsyncClient(timeout=240) as c:
        r = await c.post(f"http://{host}/api/config", json=body)
    r.raise_for_status()
    return r.json()


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------
def _sse(event: str, data: dict[str, Any]) -> bytes:
    return f"event: {event}\ndata: {json.dumps(data)}\n\n".encode()


@app.get("/")
async def page(request: Request) -> Response:
    res = HTMLResponse(PAGE, headers={"Cache-Control": "no-store"})
    if not request.cookies.get(VIEWER_COOKIE):
        res.set_cookie(VIEWER_COOKIE, secrets.token_urlsafe(24), httponly=True, secure=True, samesite="lax")
    return res


@app.get("/_gate/viewer-ok")
async def viewer_ok(request: Request) -> Response:
    mine = request.cookies.get(VIEWER_COOKIE)
    return Response(status_code=204 if mine and mine == _active_viewer else 403)


@app.get("/_gate/enter")
async def enter(t: str = "") -> Response:
    name, expires = _tickets.pop(t, ("", 0.0))
    if not name or expires < time.time():
        return RedirectResponse("/", status_code=302)
    value, max_age = id_cookie(name)
    res = RedirectResponse("/", status_code=302)
    res.set_cookie(ID_COOKIE, value, max_age=max_age, httponly=True, secure=True, samesite="lax", path="/")
    return res


@app.post("/_gate/login")
async def login(request: Request) -> Response:
    viewer = request.cookies.get(VIEWER_COOKIE)
    if not viewer:
        return JSONResponse({"message": "Reload the page, then try again."}, status_code=400)
    if _lock.locked():
        return JSONResponse({"message": "Someone else is signing in right now. Try again in a minute."},
                            status_code=409)
    base_url = re.sub(r"/+$", "", os.environ.get("CREATIO_BASE_URL", ""))
    q: asyncio.Queue[bytes | None] = asyncio.Queue()

    async def run() -> None:
        global _active_viewer
        from .browser_login import login_via_browser

        profile = Path(tempfile.mkdtemp(prefix="gate-profile-"))
        ms: list[str] = []

        def watch(context: Any) -> None:
            context.on("request", lambda req: ms.extend(microsoft_logins(req)))

        async with _lock:
            _active_viewer = viewer
            try:
                progress = lambda m: q.put_nowait(_sse("progress", {"message": m}))  # noqa: E731
                cookies = await login_via_browser(base_url, progress, profile_dir=profile, on_context=watch)
                _active_viewer = None
                progress("Checking who you are in Creatio…")
                who = await creatio_identity(base_url, cookies)
                name = match(who, ms)
                if not name:
                    shown = who.get("email") or who.get("login") or (ms[0] if ms else "") or who.get("name") or "an unknown user"
                    q.put_nowait(_sse("error", {"message": f"You're signed in to Creatio as {shown}, but you haven't "
                                                           "been added to Case Lookup yet. Ask to be added.",
                                                "who": who, "microsoft": ms}))
                    return
                progress("Opening your workspace…")
                result = await hand_off(name, cookies)
                ticket = secrets.token_urlsafe(24)
                _tickets[ticket] = (name, time.time() + TICKET_TTL_S)
                q.put_nowait(_sse("done", {"name": name, "enter": f"/_gate/enter?t={ticket}",
                                           "connection": result.get("connection")}))
            except Exception as e:  # noqa: BLE001
                q.put_nowait(_sse("error", {"message": str(e) or e.__class__.__name__}))
            finally:
                _active_viewer = None
                shutil.rmtree(profile, ignore_errors=True)
                q.put_nowait(None)

    asyncio.create_task(run())

    async def stream():
        while (item := await q.get()) is not None:
            yield item

    return StreamingResponse(stream(), media_type="text/event-stream", headers={"Cache-Control": "no-store"})


PAGE = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Creatio Case Lookup</title>
<style>
  :root { --bg:#f6f7f9; --card:#fff; --fg:#1f2329; --muted:#5f6368; --accent:#4f6bff; --line:#e3e5e8; --err:#c5221f; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#16181c; --card:#1f2329; --fg:#e8eaed; --muted:#9aa0a6; --accent:#7b8cff; --line:#33373d; --err:#f28b82; }
  }
  html, body { margin:0; background:var(--bg); color:var(--fg); font:15px/1.5 system-ui, "Segoe UI", sans-serif; }
  main { max-width:460px; margin:12vh auto; padding:0 16px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:28px; }
  h1 { font-size:20px; margin:0 0 6px; }
  p { margin:0 0 18px; color:var(--muted); }
  button { padding:9px 18px; border:0; border-radius:8px; background:var(--accent); color:#fff; font:600 15px system-ui, sans-serif; cursor:pointer; }
  button:disabled { opacity:.6; cursor:default; }
  #status { margin-top:14px; min-height:1.5em; }
  #status.err { color:var(--err); }
  .hint { font-size:13px; color:var(--muted); }
</style>
</head>
<body>
<main><div class="card">
  <h1>Creatio Case Lookup</h1>
  <p>Sign in with your Creatio account. The tool recognises you and opens your own workspace.</p>
  <button id="browserLoginBtn">Log in with Creatio…</button>
  <div id="status" role="status"></div>
</div></main>
<script>
const btn = document.getElementById("browserLoginBtn");
const status = document.getElementById("status");
function say(msg, err) { status.textContent = msg; status.className = err ? "err" : ""; }
// The viewer tab is opened by vnc-helper.js (injected in Azure); close it once sign-in ends
function closeViewer() { if (window.cclCloseViewer) window.cclCloseViewer(); }
btn.addEventListener("click", async () => {
  btn.disabled = true;
  say("Starting…");
  try {
    const res = await fetch("/_gate/login", { method: "POST" });
    if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.message || "Sign-in failed (" + res.status + ")"); }
    const reader = res.body.getReader(), dec = new TextDecoder();
    let buf = "", ended = false;
    while (!ended) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\\n\\n")) >= 0) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2);
        const ev = (block.match(/^event: (.*)$/m) || [])[1];
        const data = JSON.parse((block.match(/^data: (.*)$/m) || [, "{}"])[1]);
        if (ev === "progress") say(data.message);
        else if (ev === "error") { closeViewer(); say(data.message, true); ended = true; }
        else if (ev === "done") { closeViewer(); say("Welcome, " + data.name + ". Opening your workspace…"); location.href = data.enter; ended = true; }
      }
    }
  } catch (e) { say(e.message, true); }
  btn.disabled = false;
});
</script>
</body>
</html>
"""
