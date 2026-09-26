"""Local web app for the Creatio Case Lookup workflow.

A small localhost-only HTTP server (FastAPI on uvicorn) that serves the static
UI from ../public and a JSON API backed by the shared read-only Creatio client.
It is a single-user local tool: it binds to 127.0.0.1 and the only things it
ever writes are the local .env (via Settings / Workspace), the `.analysis/`
store, and — only after the user approves a fix plan or asks to save an
attachment — files inside the configured workspace folders. All Creatio access
is read-only (GET) through creatio_client.

COMPATIBILITY: the browser UI (public/app.js) predates this Python port and
was carried over unchanged, so the HTTP contract here is exactly the one it
expects — every route, method, query parameter, JSON key, status code and
error body. Change both sides together. Routing is done
by hand through one catch-all route per prefix rather than FastAPI's
per-endpoint validation, because FastAPI's own 404/405/422 bodies would not
match what the UI expects.

SSE: streams are hand-framed (`event: X\\ndata: <json>\\n\\n`, LF only) and
served through StreamingResponse. The run-based modules (analyze,
analyze_workspace, fix_plan) report through sync callbacks; those are bridged
into the response generator with an asyncio.Queue. When the client goes away
Starlette cancels the generator, and its `finally` sets the run's cancel event
and kills the child — the TS `req.on("close")` handlers.

Every validation happens BEFORE a stream opens, so a bad request gets a real
JSON error the UI can render rather than an error buried inside an open stream.
"""

from __future__ import annotations

import asyncio
import json
import math
import os
import re
import secrets
import sys
import webbrowser
from pathlib import Path
from typing import Any, AsyncIterator, Awaitable, Callable

from fastapi import FastAPI, Request
from fastapi.responses import Response, StreamingResponse

from . import paths as _paths
from .analyze import analyze_cases, claude_available
from .analyze_workspace import analyze_workspace
from .case_brief import (
    CaseNumberError,
    brief_age_hours,
    build_brief,
    get_bound_case,
    load_brief,
    save_brief,
    set_bound_case,
    validate_case_number,
    with_case_info,
)
from .case_files import is_case_analysis_stale, with_case_files
from .case_lookup import (
    OPEN_ACTIVE,
    STATUS_NAMES,
    find_cases,
    get_attachments,
    get_case_detail,
    get_case_info,
    resolve_account,
    resolve_owner,
)
from .case_scope import compute_case_scope
from .creatio_client import (
    ALLOWED_ENTITIES,
    BASE_URL,
    FILE_DOWNLOAD_ENTITIES,
    MAX_TOP,
    AuthError,
    download_file,
    resolve_cookie_env,
    test_connection,
)
from .env import read_env_file, write_env_file
from .analyze import default_model
from .claude_run import (
    EFFORT_CHOICES,
    MODEL_CHOICES,
    OUTPUT_STYLE_CHOICES,
    ClaudeCliError,
    app_settings,
    write_app_settings,
)
from .lifecycle import LifecycleError, groups_for_owner, lifecycle_allowed, lifecycle_sample, validate_request
from .lifecycle_export import build_report_html, build_xlsx, publish_report
from .preflight import run_checks
from .fix_plan import (
    FixPlanError,
    apply_plan,
    check_revision_request,
    locked_steps,
    final_report,
    latest_plan,
    load_plan,
    mark_step,
    plan_fix,
    recheck_plan,
    verify_step,
    with_created_files,
)
from .workspace import (
    MAX_PATHS,
    WorkspacePathError,
    WorkspaceWriteError,
    enumerate_workspaces,
    file_cap,
    get_workspace_paths,
    index_entry_for,
    is_stale,
    js_parse_int,
    js_round1,
    load_analysis_for,
    save_asset_to_workspace,
    set_workspace_paths,
    validate_workspace_path,
)

# Module-level so tests can point it elsewhere (serve_static reads it per request).
PUBLIC_DIR: Path = _paths.PUBLIC_DIR
HOST = "127.0.0.1"
PORT: int = js_parse_int(os.environ.get("CREATIO_APP_PORT") or "3000") or 3000

MIME: dict[str, str] = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".json": "application/json; charset=utf-8",
}

SSE_HEADERS = {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
}

HEARTBEAT_S = 15.0

CLAUDE_MISSING = (
    "The Claude CLI was not found. Install it (npm i -g @anthropic-ai/claude-code), "
    "run `claude` once to log in, then restart the app."
)

# Background tasks that must outlive the request that started them (browser
# login keeps going if the tab is closed, as in TS). Held here so they are not
# garbage-collected mid-run.
_BACKGROUND: set[asyncio.Task] = set()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _js_safe(v: Any) -> Any:
    """JSON.stringify turns NaN/Infinity into null; Python would emit bare NaN."""
    if isinstance(v, float) and not math.isfinite(v):
        return None
    if isinstance(v, dict):
        return {k: _js_safe(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [_js_safe(x) for x in v]
    return v


def _dumps(obj: Any) -> str:
    """Compact JSON, like JSON.stringify(obj)."""
    return json.dumps(_js_safe(obj), separators=(",", ":"), ensure_ascii=False)


def send_json(status: int, body: Any) -> Response:
    return Response(
        content=_dumps(body).encode("utf-8"),
        status_code=status,
        headers={"Content-Type": "application/json; charset=utf-8"},
    )


def send_error(err: BaseException) -> Response:
    """Map an error to a structured JSON response. AuthError -> {error:'auth'} so
    the UI can show an "open Settings" banner instead of a raw message."""
    if isinstance(err, AuthError):
        return send_json(401, {"error": "auth", "message": str(err)})
    return send_json(500, {"error": "server", "message": str(err)})


class _BodyError(Exception):
    """An unparseable request body (TS readBody's `Invalid JSON body.`)."""


async def read_body(request: Request) -> Any:
    """Parse the raw request body as JSON, whatever its Content-Type. An empty
    body is `{}`; anything unparseable is "Invalid JSON body." (a 500, as in TS)."""
    raw = await request.body()
    if not raw:
        return {}
    try:
        parsed = json.loads(raw.decode("utf-8", errors="replace"))
    except ValueError:
        raise _BodyError("Invalid JSON body.") from None
    # Property reads on a non-object behave like `undefined` in JS.
    return parsed if isinstance(parsed, dict) else {}


def mask(v: str) -> str:
    if not v:
        return ""
    if len(v) <= 8:
        return "•" * len(v)
    return v[:4] + "•" * min(20, len(v) - 8) + v[-4:]


def sse(event: str, data: Any) -> str:
    return f"event: {event}\ndata: {_dumps(data)}\n\n"


def _pick(src: dict | None, *keys: str) -> dict:
    """The listed keys that are present — JSON.stringify drops `undefined`."""
    src = src or {}
    return {k: src[k] for k in keys if k in src}


def _stream(gen: AsyncIterator[str]) -> StreamingResponse:
    return StreamingResponse(gen, status_code=200, headers=dict(SSE_HEADERS))


_END = object()


async def _drain(q: asyncio.Queue, heartbeat: bool) -> AsyncIterator[str]:
    """Yield queued SSE frames until the _END sentinel, with `: ping` comments
    every HEARTBEAT_S seconds when asked (the TS setInterval)."""
    loop = asyncio.get_running_loop()
    next_ping = loop.time() + HEARTBEAT_S
    while True:
        if heartbeat:
            timeout = max(0.0, next_ping - loop.time())
            try:
                item = await asyncio.wait_for(q.get(), timeout)
            except asyncio.TimeoutError:
                # A tool-using run can sit silent for a minute while the model
                # reads files. A bare SSE comment keeps proxies and the fetch
                # reader alive; consumeSse finds no `data:` and skips it.
                next_ping += HEARTBEAT_S
                yield ": ping\n\n"
                continue
        else:
            item = await q.get()
        if item is _END:
            return
        yield item


# ---------------------------------------------------------------------------
# Static file serving (path-traversal safe)
# ---------------------------------------------------------------------------
def serve_static(url_path: str) -> Response:
    rel = "/index.html" if url_path == "/" else url_path
    root = Path(os.path.normpath(PUBLIC_DIR))
    file_path = Path(os.path.normpath(os.path.join(root, rel.lstrip("/\\"))))
    try:
        inside = file_path == root or file_path.is_relative_to(root)
    except ValueError:
        inside = False
    if not inside:
        return Response(content=b"Forbidden", status_code=403)
    try:
        data = file_path.read_bytes()
    except OSError:
        return Response(content=b"Not found", status_code=404, headers={"Content-Type": "text/plain"})
    ctype = MIME.get(file_path.suffix.lower(), "application/octet-stream")
    return Response(content=data, status_code=200, headers={"Content-Type": ctype})


# ---------------------------------------------------------------------------
# Case-scoped workspace helpers
# ---------------------------------------------------------------------------
def bound_brief() -> dict:
    """{"brief": ...} for the bound case, or {"error": reason} when there isn't one."""
    number = get_bound_case()
    if not number:
        return {"error": "No case is bound. Pick one in phase 1 first."}
    brief = load_brief(number)
    if not brief:
        return {
            "error": f"{number} is bound but nothing is stored for it. Search for it in phase 1 and pick it again to fetch the details."
        }
    return {"brief": brief}


async def ensure_case_info(brief: dict) -> dict:
    """Give a brief stored before case info was captured its district/school
    codes, fetched now and saved back. Best-effort: a failed read (expired
    session, missing field) leaves the brief as it was."""
    if "codes" in brief or not brief.get("id"):
        return brief
    try:
        with_case_info(brief, await get_case_info(brief["id"]))
        save_brief(brief)
    except Exception:  # noqa: BLE001 — the codes help; they never block
        pass
    return brief


def editable_enumeration(abs_paths: list[str], case_number: str | None, plan: dict | None = None) -> dict:
    """The census a fix for `case_number` may edit: the top-level files, the
    files that case's scoped analysis selected in subfolders, and any new files
    `plan` (or the plans it revises) created."""
    en = enumerate_workspaces(abs_paths)
    ca = load_analysis_for(abs_paths, "case", case_number) if case_number else None
    return with_created_files(with_case_files(en, ca["meta"].get("selection") if ca else None, abs_paths), plan)


def to_scope_input(scope: dict, brief: dict) -> dict:
    out: dict = {
        "caseNumber": scope["caseNumber"],
        "terms": [t["term"] for t in scope["terms"]],
        "files": [
            {k: f.get(k) for k in ("rel", "folder", "score", "reason", "size", "mtime", "ext")}
            for f in scope["files"]
        ],
    }
    if brief.get("fetchedAt") is not None:
        out["briefFetchedAt"] = brief["fetchedAt"]
    return out


def _configured_abs() -> list[str]:
    return [validate_workspace_path(p) for p in get_workspace_paths()]


# ---------------------------------------------------------------------------
# API handlers — each returns a Response; exceptions map through send_error.
# ---------------------------------------------------------------------------
Handler = Callable[[Request], Awaitable[Response]]
ROUTES: dict[tuple[str, str], Handler] = {}


def route(method: str, path: str) -> Callable[[Handler], Handler]:
    def deco(fn: Handler) -> Handler:
        ROUTES[(method, path)] = fn
        return fn

    return deco


# Static config the UI needs to render its controls.
@route("GET", "/api/meta")
async def api_meta(request: Request) -> Response:
    return send_json(
        200,
        {
            "baseUrl": BASE_URL,
            "allowlist": ALLOWED_ENTITIES,
            "maxTop": MAX_TOP,
            "statuses": list(STATUS_NAMES),
            "openActive": OPEN_ACTIVE,
            "aiAvailable": claude_available(),
            "workspacePaths": get_workspace_paths(),
            "workspaceCap": file_cap(),
            "workspaceCase": get_bound_case(),
        },
    )


# Settings: the Claude settings the app's runs use (.claude/settings.json).
@route("GET", "/api/claude-settings")
async def api_claude_settings_get(request: Request) -> Response:
    return send_json(200, _claude_settings_body())


@route("POST", "/api/claude-settings")
async def api_claude_settings_post(request: Request) -> Response:
    body = await read_body(request)
    updates = {k: body[k] for k in ("model", "effortLevel", "outputStyle") if isinstance(body.get(k), str) and body[k].strip()}
    try:
        write_app_settings(updates)
    except ValueError as e:
        return send_json(400, {"error": "server", "message": str(e)})
    return send_json(200, {"saved": True, **_claude_settings_body()})


def _claude_settings_body() -> dict[str, Any]:
    s = app_settings()
    env_model = (os.environ.get("CREATIO_APP_MODEL") or read_env_file().get("CREATIO_APP_MODEL") or "").strip()
    return {
        "model": s.get("model", ""),
        "effortLevel": s.get("effortLevel", ""),
        "outputStyle": s.get("outputStyle", ""),
        "envModel": env_model,
        "effectiveModel": default_model(),
        "choices": {"model": MODEL_CHOICES, "effortLevel": EFFORT_CHOICES, "outputStyle": OUTPUT_STYLE_CHOICES},
    }


# Setup tab: the same checklist start-app.bat prints, re-run live.
@route("GET", "/api/preflight")
async def api_preflight(request: Request) -> Response:
    return send_json(200, await run_checks())


@route("GET", "/api/test-auth")
async def api_test_auth(request: Request) -> Response:
    return send_json(200, await test_connection())


# Resolve a name to candidate GUIDs for the disambiguation picker.
@route("GET", "/api/resolve")
async def api_resolve(request: Request) -> Response:
    typ = request.query_params.get("type")
    name = (request.query_params.get("name") or "").strip()
    if not name:
        return send_json(200, {"candidates": []})
    candidates = await (resolve_account(name) if typ == "account" else resolve_owner(name))
    return send_json(200, {"candidates": candidates})


# Attachment proxy — streams an image/file from Creatio's FileService.
@route("GET", "/api/file")
async def api_file(request: Request) -> Response:
    entity = request.query_params.get("entity") or ""
    id = request.query_params.get("id") or ""
    if entity not in FILE_DOWNLOAD_ENTITIES:
        return send_json(400, {"error": "server", "message": "File entity not allowed."})
    file = await download_file(entity, id)
    return Response(
        content=file["buffer"],
        status_code=200,
        headers={
            "Content-Type": file["contentType"],
            "Cache-Control": "private, max-age=300",
        },
    )


# Settings: read current config (cookies masked).
@route("GET", "/api/config")
async def api_config_get(request: Request) -> Response:
    file = read_env_file()
    c = resolve_cookie_env()
    aspx, csrf, loader = c["aspx"], c["csrf"], c["loader"]
    return send_json(
        200,
        {
            "baseUrl": file.get("CREATIO_BASE_URL") or BASE_URL or "",
            "allowlist": file.get("CREATIO_ALLOWED_ENTITIES") or ", ".join(ALLOWED_ENTITIES),
            "maxTop": file.get("CREATIO_MAX_TOP") or str(MAX_TOP),
            "cookies": {
                "aspx": mask(aspx),
                "csrf": mask(csrf),
                "loader": mask(loader),
                "hasAspx": bool(aspx),
                "hasCsrf": bool(csrf),
                "hasLoader": bool(loader),
            },
        },
    )


def _nonblank(body: dict, key: str) -> str | None:
    v = body.get(key)
    return v.strip() if isinstance(v, str) and v.strip() else None


# Settings: write config to .env. Only fields present are updated; blank cookie
# fields are treated as "leave unchanged" so a save without re-pasting secrets
# doesn't wipe them.
@route("POST", "/api/config")
async def api_config_post(request: Request) -> Response:
    body = await read_body(request)
    updates: dict[str, str] = {}
    if (v := _nonblank(body, "baseUrl")) is not None:
        updates["CREATIO_BASE_URL"] = v
    if isinstance(body.get("allowlist"), str):
        updates["CREATIO_ALLOWED_ENTITIES"] = body["allowlist"].strip()
    if (v := _nonblank(body, "maxTop")) is not None:
        updates["CREATIO_MAX_TOP"] = v
    if (v := _nonblank(body, "aspx")) is not None:
        updates["CREATIO_ASPXAUTH"] = v
    if (v := _nonblank(body, "csrf")) is not None:
        updates["CREATIO_BPMCSRF"] = v
    if (v := _nonblank(body, "loader")) is not None:
        updates["CREATIO_BPMLOADER"] = v

    write_env_file(updates)

    # Cookies take effect immediately (client re-reads .env on next query).
    # base URL / allowlist / row cap are read once at startup — flag if changed.
    restart_needed = any(
        k in updates for k in ("CREATIO_BASE_URL", "CREATIO_ALLOWED_ENTITIES", "CREATIO_MAX_TOP")
    )

    # Validate the (possibly new) cookies right away.
    test = await test_connection()
    return send_json(200, {"saved": True, "restartNeeded": restart_needed, "connection": test})


# ---------------------------------------------------------------------------
# Lifecycle: status/owner history of a team's closed cases (CaseLifecycle).
# ---------------------------------------------------------------------------
@route("GET", "/api/lifecycle/groups")
async def api_lifecycle_groups(request: Request) -> Response:
    try:
        groups = await groups_for_owner(request.query_params.get("owner") or "")
    except LifecycleError as e:
        return send_json(400, {"error": "server", "message": str(e)})
    return send_json(200, {"groups": groups, "allowed": lifecycle_allowed()})


# Finished pulls, so Excel / artifact outputs can be made after the fact.
# In memory only: a restart forgets them, and the UI just pulls again.
_LC_RUNS: dict[str, dict[str, Any]] = {}
_LC_KEEP = 5


def _lc_group_name(v: Any) -> str:
    return re.sub(r"[\x00-\x1f]", "", v)[:80].strip() if isinstance(v, str) else ""


# Pull a team's closed cases + lifecycle rows, streaming progress (SSE):
# progress {phase, done, total} ... then result {runId, cases, summary} | error.
@route("POST", "/api/lifecycle")
async def api_lifecycle(request: Request) -> Response:
    body = await read_body(request)
    try:
        group_id, since, max_cases = validate_request(body.get("groupId"), body.get("since"), body.get("maxCases") or 100)
    except LifecycleError as e:
        return send_json(400, {"error": "server", "message": str(e)})
    group = _lc_group_name(body.get("groupName"))

    async def gen() -> AsyncIterator[str]:
        q: asyncio.Queue = asyncio.Queue()

        async def work() -> None:
            try:
                result = await lifecycle_sample(group_id, since, max_cases, lambda p: q.put_nowait(sse("progress", p)))
                run_id = secrets.token_hex(6)
                _LC_RUNS[run_id] = {"result": result, "group": group, "since": since}
                for old in list(_LC_RUNS)[:-_LC_KEEP]:
                    _LC_RUNS.pop(old, None)
                q.put_nowait(sse("result", {"runId": run_id, **result}))
            except AuthError as e:
                q.put_nowait(sse("error", {"kind": "auth", "message": str(e)}))
            except Exception as e:  # noqa: BLE001
                q.put_nowait(sse("error", {"message": str(e)}))
            q.put_nowait(_END)

        task = asyncio.ensure_future(work())
        try:
            async for frame in _drain(q, heartbeat=True):
                yield frame
        finally:
            if not task.done():
                task.cancel()

    return _stream(gen())


def _lc_run(request_run: Any) -> dict[str, Any] | None:
    return _LC_RUNS.get(request_run) if isinstance(request_run, str) else None


@route("GET", "/api/lifecycle/export")
async def api_lifecycle_export(request: Request) -> Response:
    run = _lc_run(request.query_params.get("run"))
    if not run:
        return send_json(404, {"error": "server", "message": "That pull is no longer available. Pull lifecycle again."})
    data = build_xlsx(run["result"], run["group"], run["since"])
    name = re.sub(r"[^A-Za-z0-9 _-]", "", run["group"] or "Case") + " lifecycle.xlsx"
    return Response(
        content=data,
        status_code=200,
        headers={
            "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "Content-Disposition": f'attachment; filename="{name}"',
        },
    )


# The report page itself, served locally — works without the Claude CLI and is
# the fallback when publishing fails.
@route("GET", "/api/lifecycle/report")
async def api_lifecycle_report(request: Request) -> Response:
    run = _lc_run(request.query_params.get("run"))
    if not run:
        return send_json(404, {"error": "server", "message": "That pull is no longer available. Pull lifecycle again."})
    html = build_report_html(run["result"], run["group"], run["since"])
    return Response(content=html.encode("utf-8"), status_code=200, headers={"Content-Type": "text/html; charset=utf-8"})


@route("POST", "/api/lifecycle/publish")
async def api_lifecycle_publish(request: Request) -> Response:
    body = await read_body(request)
    run_id = body.get("runId")
    run = _lc_run(run_id)
    if not run:
        return send_json(404, {"error": "server", "message": "That pull is no longer available. Pull lifecycle again."})
    if not claude_available():
        return send_json(400, {"error": "server", "message": CLAUDE_MISSING})
    html = build_report_html(run["result"], run["group"], run["since"])
    try:
        url = await publish_report(html, run_id)
    except ClaudeCliError as e:
        return send_json(500, {"error": "server", "message": e.message})
    run["artifactUrl"] = url
    return send_json(200, {"url": url})




# ---------------------------------------------------------------------------
# Workspace: the working directory the user is analyzing.
# ---------------------------------------------------------------------------


# Current workspace config + what's already stored for it.
@route("GET", "/api/workspace")
async def api_workspace_get(request: Request) -> Response:
    raw = get_workspace_paths()
    body: dict[str, Any] = {
        "paths": raw,
        "valid": False,
        "maxPaths": MAX_PATHS,
        "cap": file_cap(),
        "aiAvailable": claude_available(),
        "analysis": {"directory": None, "files": []},
    }
    if raw:
        try:
            abs_paths = [validate_workspace_path(p) for p in raw]
            body["paths"] = abs_paths
            body["valid"] = True
            entry = index_entry_for(abs_paths)
            if entry:
                body["analysis"] = {"directory": entry.get("directory"), "files": entry.get("files")}
            # Flag a stored report that predates the files it describes.
            stored = load_analysis_for(abs_paths, "directory")
            if stored:
                try:
                    body["stale"] = is_stale(stored["meta"], enumerate_workspaces(abs_paths))
                except Exception:  # noqa: BLE001 — enumeration problems surface on /files
                    pass
            # The bound case's scoped analysis, if one exists for these folders.
            number = get_bound_case()
            ca = load_analysis_for(abs_paths, "case", number) if number else None
            if ca:
                brief = load_brief(number)
                meta = ca["meta"]
                case_analysis: dict[str, Any] = {
                    "caseNumber": number,
                    "finishedAt": meta.get("finishedAt"),
                    "files": meta.get("selection") or [],
                }
                if "truncated" in meta:
                    case_analysis["truncated"] = meta["truncated"]
                case_analysis["stale"] = is_case_analysis_stale(meta, (brief or {}).get("fetchedAt"))
                body["caseAnalysis"] = case_analysis
        except Exception as e:  # noqa: BLE001 — reported inline, not as a failure
            body["error"] = str(e)
    return send_json(200, body)


# Save the workspace folders to .env (takes effect immediately — read live).
# Each path is validated individually so the UI can point at the bad one.
@route("POST", "/api/workspace")
async def api_workspace_post(request: Request) -> Response:
    request_body = await read_body(request)
    if isinstance(request_body.get("paths"), list):
        incoming = request_body["paths"]
    elif isinstance(request_body.get("path"), str):
        incoming = [request_body["path"]]
    else:
        incoming = []
    trimmed = [t for t in ((p.strip() if isinstance(p, str) else "") for p in incoming) if t][:MAX_PATHS]

    # Clearing is explicit rather than "save nothing", so an empty form can still
    # be rejected as a mistake. Stored analyses are left on disk: they are keyed
    # by folder, so re-entering the same path brings its report back instead of
    # costing another run.
    if request_body.get("clear") is True:
        set_workspace_paths([])
        return send_json(200, {"saved": True, "cleared": True, "paths": [], "enumeration": None})

    if not trimmed:
        return send_json(400, {"error": "path", "message": "Enter the folder you're working in."})

    abs_paths: list[str] = []
    for i, p in enumerate(trimmed):
        try:
            one = validate_workspace_path(p)
        except WorkspacePathError as e:
            # `index` lets the UI mark the offending box instead of the first one.
            return send_json(400, {"error": "path", "index": i, "message": str(e)})
        # Silently collapse a folder listed twice rather than double-counting its
        # files against the cap.
        if not any(x.lower() == one.lower() for x in abs_paths):
            abs_paths.append(one)

    set_workspace_paths(abs_paths)
    return send_json(200, {"saved": True, "paths": abs_paths, "enumeration": enumerate_workspaces(abs_paths)})


def _path_error(e: BaseException) -> Response:
    if isinstance(e, WorkspacePathError):
        return send_json(400, {"error": "path", "message": str(e)})
    return send_error(e)


# Census of the top-level source files — drives the count and the over-cap choice.
@route("GET", "/api/workspace/files")
async def api_workspace_files(request: Request) -> Response:
    try:
        qp = request.query_params.getlist("path")
        abs_paths = [validate_workspace_path(p) for p in (qp or get_workspace_paths())]
        if not abs_paths:
            return send_json(400, {"error": "path", "message": "No workspace folder configured."})
        return send_json(200, enumerate_workspaces(abs_paths))
    except Exception as e:  # noqa: BLE001
        return _path_error(e)


# Read back a stored analysis.
@route("GET", "/api/workspace/analysis")
async def api_workspace_analysis(request: Request) -> Response:
    try:
        qp = request.query_params.getlist("path")
        abs_paths = [validate_workspace_path(p) for p in (qp or get_workspace_paths())]
        mode = request.query_params.get("mode") or "directory"
        file = request.query_params.get("file") or None
        loaded = load_analysis_for(
            abs_paths,
            mode if mode in ("file", "case") else "directory",
            get_bound_case() if mode == "case" else file,
        )
        if not loaded:
            return send_json(404, {"error": "not_found", "message": "No stored analysis for that folder."})
        return send_json(200, {"meta": loaded["meta"], "markdown": loaded["body"]})
    except Exception as e:  # noqa: BLE001
        return _path_error(e)


# Instant, model-free preview of what a case-scoped analysis would read: the
# case keywords and the related files (searched recursively).
@route("GET", "/api/workspace/case-scope")
async def api_workspace_case_scope(request: Request) -> Response:
    try:
        bb = bound_brief()
        if "error" in bb:
            return send_json(400, {"error": "case", "message": bb["error"]})
        abs_paths = _configured_abs()
        if not abs_paths:
            return send_json(400, {"error": "path", "message": "No workspace folder configured."})
        await ensure_case_info(bb["brief"])
        scope = await compute_case_scope(bb["brief"], abs_paths)
        return send_json(200, scope)
    except Exception as e:  # noqa: BLE001
        return _path_error(e)


# ---------------------------------------------------------------------------
# The bound case — phase 1 of the Workspace tab.
#
# The binding lives in .env and the fetched brief in .analysis/cases/, so it
# survives a browser reload and is readable by the creatio-case-fix skill in a
# fresh Claude Code session. The server itself stays stateless.
# ---------------------------------------------------------------------------
def _age_hours(brief: dict | None) -> Any:
    return js_round1(brief_age_hours(brief)) if brief else None


@route("GET", "/api/workspace/case")
async def api_workspace_case_get(request: Request) -> Response:
    number = get_bound_case()
    brief = load_brief(number) if number else None
    return send_json(200, {"number": number, "brief": brief, "ageHours": _age_hours(brief)})


# Bind a case (or clear the binding with an empty number).
#
# The case is re-fetched from Creatio by number rather than trusting the row the
# browser posted: the brief is the artifact the fix skill acts on, so it has to
# come from the source.
@route("POST", "/api/workspace/case")
async def api_workspace_case_post(request: Request) -> Response:
    try:
        request_body = await read_body(request)
        raw = request_body["number"].strip() if isinstance(request_body.get("number"), str) else ""

        if not raw:
            set_bound_case("")
            return send_json(200, {"saved": True, "number": "", "brief": None, "ageHours": None})

        number = validate_case_number(raw)
        found = await find_cases({"mode": "number", "numbers": [number]})
        row = found["cases"][0] if found["cases"] else None
        if not row:
            return send_json(
                404,
                {
                    "error": "not_found",
                    "message": f"No case with number {number}. Check the number, or search by owner instead.",
                },
            )

        detail = await get_case_detail(row, ["description", "timeline"])
        # The district/school codes say which client folder a fix belongs in.
        # Optional: a failed read just leaves them out of the brief.
        try:
            detail["caseInfo"] = await get_case_info(row["Id"])
        except AuthError:
            raise
        except Exception:  # noqa: BLE001
            pass

        # Attachments need CaseFile in the entity allowlist. A missing entry must
        # not fail the bind — the brief records it as a caveat instead.
        attachments = None
        try:
            attachments = await get_attachments(row["Id"])
        except AuthError:
            raise
        except Exception:  # noqa: BLE001
            pass

        brief = build_brief(row, detail, attachments)
        save_brief(brief)
        set_bound_case(brief["number"])

        return send_json(200, {"saved": True, "number": brief["number"], "brief": brief, "ageHours": 0})
    except CaseNumberError as e:
        return send_json(400, {"error": "case", "message": str(e)})


_ATTACHMENT_ID_RE = re.compile(r"[0-9a-fA-F-]{36}")


# Save a case attachment (an image — e.g. the school's logo) into one of the
# configured workspace folders, so the template can actually use it.
#
# This writes outside the repo, so every rule lives in workspace.py: images only,
# the folder must be one that's configured, the client-supplied name is reduced
# to a safe basename, and replacing an existing file needs an explicit confirm
# and backs the original up first.
@route("POST", "/api/workspace/attachment")
async def api_workspace_attachment(request: Request) -> Response:
    try:
        request_body = await read_body(request)
        id = request_body["id"] if isinstance(request_body.get("id"), str) else ""
        if not _ATTACHMENT_ID_RE.fullmatch(id):
            return send_json(400, {"error": "server", "message": "Invalid attachment id."})

        allowed = _configured_abs()
        if not allowed:
            return send_json(
                400,
                {"error": "path", "message": "No workspace folder is configured — set one in phase 2 first."},
            )

        file = await download_file("CaseFile", id)
        folder = request_body.get("folder")
        name = request_body.get("name")
        saved = save_asset_to_workspace(
            folder if isinstance(folder, str) and folder else allowed[0],
            name if isinstance(name, str) and name else (file.get("filename") or ""),
            file["buffer"],
            overwrite=request_body.get("overwrite") is True,
            allowed=allowed,
        )

        return send_json(
            200,
            {
                "saved": True,
                "name": saved["name"],
                "path": saved["path"],
                "bytes": len(file["buffer"]),
                "overwrote": saved["overwrote"],
                "backup": saved.get("backup") or None,
            },
        )
    except WorkspaceWriteError as e:
        # `code` lets the UI offer a replace instead of just reporting a wall.
        return send_json(400, {"error": "asset", "code": e.code, "message": str(e)})
    except Exception as e:  # noqa: BLE001
        return _path_error(e)


# ---------------------------------------------------------------------------
# Phase 3: plan a fix, then apply it on approval.
#
# The planning run has NO write tools; applying is done by plain Python in
# fix_plan.py after the user approves and every match is re-verified. See that
# module's docstring for why the split is the security model.
# ---------------------------------------------------------------------------


# The last plan for the bound case, so a browser reload doesn't lose it.
@route("GET", "/api/workspace/fix")
async def api_workspace_fix_get(request: Request) -> Response:
    number = get_bound_case()
    plan = latest_plan(number) if number else None
    # Re-check against the files as they are now — a plan read back later is a
    # claim about the past, and the review screen must show current reality.
    if plan:
        try:
            abs_paths = _configured_abs()
            if abs_paths:
                plan = recheck_plan(plan, editable_enumeration(abs_paths, plan.get("caseNumber"), plan), abs_paths)
        except Exception:  # noqa: BLE001 — unreadable workspace: hand back the stored plan as-is
            pass
    return send_json(200, {"plan": plan})


_PLAN_CASE_RE = re.compile(r"^SR\d{4,12}(?=-)", re.ASCII)


# Apply takes only a plan ID — never the edits themselves. The server re-reads
# the plan it wrote, so the browser can't ask for an arbitrary file write.
@route("POST", "/api/workspace/fix/apply")
async def api_workspace_fix_apply(request: Request) -> Response:
    try:
        request_body = await read_body(request)
        id = request_body["id"] if isinstance(request_body.get("id"), str) else ""
        if not id:
            return send_json(400, {"error": "server", "message": "No plan id given."})
        abs_paths = _configured_abs()
        if not abs_paths:
            return send_json(400, {"error": "path", "message": "No workspace folder configured."})
        m = _PLAN_CASE_RE.match(id)
        case_number = m.group(0) if m else None
        step = _body_step(request_body)
        en = editable_enumeration(abs_paths, case_number, load_plan(id))
        result = apply_plan(id, en, abs_paths, reapply=request_body.get("reapply") is True, step=step)
        out: dict = {"applied": result["applied"], "backupDir": result["backupDir"]}
        if step is not None:
            # Check the step landed before the UI unlocks the next one.
            out["verify"] = verify_step(load_plan(id) or {}, step, en, abs_paths)
        return send_json(200, out)
    except FixPlanError as e:
        return send_json(400, {"error": "fix", "message": str(e)})
    except Exception as e:  # noqa: BLE001
        return _path_error(e)


def _body_step(body: dict) -> int | None:
    v = body.get("step")
    if v is None:
        return None
    if isinstance(v, int) and not isinstance(v, bool) and v > 0:
        return v
    raise FixPlanError("The step must be a positive whole number.")


# A manual step (work items, deploys, a decision) is carried out by the user;
# this records it as done, or any step as skipped, so the next step unlocks.
@route("POST", "/api/workspace/fix/step-done")
async def api_workspace_fix_step_done(request: Request) -> Response:
    try:
        body = await read_body(request)
        id = body["id"] if isinstance(body.get("id"), str) else ""
        step = _body_step(body)
        if not id or step is None:
            return send_json(400, {"error": "server", "message": "A plan id and a step are required."})
        note = body["note"] if isinstance(body.get("note"), str) else ""
        plan = mark_step(id, step, skipped=body.get("skipped") is True, note=note)
        return send_json(200, {"stepStatus": plan.get("stepStatus") or {}})
    except FixPlanError as e:
        return send_json(400, {"error": "fix", "message": str(e)})


# The final report: the steps, what changed, what was skipped or left open.
@route("POST", "/api/workspace/fix/finish")
async def api_workspace_fix_finish(request: Request) -> Response:
    try:
        body = await read_body(request)
        id = body["id"] if isinstance(body.get("id"), str) else ""
        if not id:
            return send_json(400, {"error": "server", "message": "No plan id given."})
        return send_json(200, final_report(id))
    except FixPlanError as e:
        return send_json(400, {"error": "fix", "message": str(e)})


# ---------------------------------------------------------------------------
# Server-Sent Event handlers
# ---------------------------------------------------------------------------


# Main search: find cases + stream per-case detail with progress (SSE).
@route("POST", "/api/cases")
async def handle_cases(request: Request) -> Response:
    body = await read_body(request)

    mode = body.get("mode")
    statuses = body["statuses"] if isinstance(body.get("statuses"), list) else OPEN_ACTIVE
    detail = body["detail"] if isinstance(body.get("detail"), list) else ["summary"]

    # Phase 1: find the cases. Errors here happen BEFORE the stream opens, so we
    # can return a normal JSON error (drives the cookie-expired banner).
    found = await find_cases(
        {
            "mode": mode,
            "guids": body.get("guids"),
            "numbers": body.get("numbers"),
            "statuses": statuses,
            "before": body.get("before"),
        }
    )

    cases = found["cases"]
    tally: dict[str, int] = {}
    for c in cases:
        tally[c.get("Status")] = tally.get(c.get("Status"), 0) + 1
    need_detail = any(d != "summary" for d in detail)

    async def gen() -> AsyncIterator[str]:
        # Hand the table over immediately.
        yield sse(
            "found",
            {
                "cases": cases,
                "tally": tally,
                "truncated": found["truncated"],
                "caveats": found["caveats"],
                "needDetail": need_detail,
                "total": len(cases),
            },
        )
        if not need_detail:
            yield sse("done", {})
            return

        # Phase 2: fetch per-case detail with limited concurrency, reporting progress.
        total = len(cases)
        st = {"done": 0, "idx": 0, "aborted": False}
        q: asyncio.Queue = asyncio.Queue()

        async def worker() -> None:
            while st["idx"] < total and not st["aborted"]:
                i = st["idx"]
                st["idx"] += 1
                try:
                    d = await get_case_detail(cases[i], detail)
                    q.put_nowait(sse("case", {"index": i, "detail": d}))
                except AuthError as e:
                    q.put_nowait(sse("error", {"kind": "auth", "message": str(e)}))
                    st["aborted"] = True
                    return
                except Exception as e:  # noqa: BLE001
                    q.put_nowait(sse("case", {"index": i, "detail": {}, "error": str(e)}))
                st["done"] += 1
                q.put_nowait(sse("progress", {"done": st["done"], "total": total}))

        concurrency = 4
        workers = [asyncio.ensure_future(worker()) for _ in range(min(concurrency, total))]

        async def finish() -> None:
            await asyncio.gather(*workers, return_exceptions=True)
            if not st["aborted"]:
                q.put_nowait(sse("done", {}))
            q.put_nowait(_END)

        closer = asyncio.ensure_future(finish())
        try:
            async for frame in _drain(q, heartbeat=False):
                yield frame
        finally:
            # Client went away (or we're done): stop handing out new cases.
            st["aborted"] = True
            if not closer.done():
                closer.cancel()
                for w in workers:
                    w.cancel()

    return _stream(gen())


# Settings: interactive browser login. Opens a real browser at Creatio's login
# page, waits for the user to sign in, and captures the session cookies —
# streams progress via SSE since this can take minutes (MFA).
@route("POST", "/api/browser-login")
async def handle_browser_login(request: Request) -> Response:
    # Read the base URL from .env rather than the startup constant so a URL the
    # user just saved in Settings works without restarting the app.
    base_url = re.sub(r"/+$", "", read_env_file().get("CREATIO_BASE_URL") or BASE_URL or "")
    if not base_url:
        return send_json(400, {"error": "server", "message": "Set the Creatio base URL first, then log in."})

    q: asyncio.Queue = asyncio.Queue()

    async def run() -> None:
        try:
            try:
                # Imported lazily so a missing/broken playwright only breaks login
                # rather than stopping the whole app from starting.
                from .browser_login import LoginCancelledError, login_via_browser
            except Exception as e:  # noqa: BLE001
                q.put_nowait(
                    sse(
                        "error",
                        {
                            "kind": "server",
                            "message": "Browser login is unavailable — playwright failed to load. "
                            "Run `pip install playwright` then `playwright install chromium`. " + str(e),
                        },
                    )
                )
                return
            try:
                cookies = await login_via_browser(base_url, lambda message: q.put_nowait(sse("progress", {"message": message})))
                updates = {"CREATIO_ASPXAUTH": cookies["aspx"], "CREATIO_BPMCSRF": cookies["csrf"]}
                # BPMLOADER is optional — don't blank an existing value if it wasn't set.
                if cookies.get("loader"):
                    updates["CREATIO_BPMLOADER"] = cookies["loader"]
                write_env_file(updates)

                q.put_nowait(sse("progress", {"message": "Verifying connection…"}))
                # The login browser has only just shut down; the first probe can
                # catch a transient socket/DNS blip. One retry keeps a blip from
                # looking like a hard failure.
                connection = await test_connection()
                if not connection.get("ok"):
                    await asyncio.sleep(1.5)
                    connection = await test_connection()
                q.put_nowait(sse("done", {"connection": connection}))
            except Exception as e:  # noqa: BLE001
                cancelled = isinstance(e, LoginCancelledError)
                q.put_nowait(sse("error", {"kind": "cancelled" if cancelled else "server", "message": str(e)}))
        finally:
            q.put_nowait(_END)

    # Like the TS handler, the login carries on if the tab is closed — the user
    # may still finish signing in, and the cookies are saved either way.
    task = asyncio.ensure_future(run())
    _BACKGROUND.add(task)
    task.add_done_callback(_BACKGROUND.discard)

    return _stream(_drain(q, heartbeat=False))


# AI analysis of a set of cases — streams the model output via SSE.
@route("POST", "/api/analyze")
async def handle_analyze(request: Request) -> Response:
    body = await read_body(request)

    preset = body.get("preset") or "summarize"
    question = body["question"] if isinstance(body.get("question"), str) else ""
    rows = body["cases"] if isinstance(body.get("cases"), list) else []
    if not rows:
        return send_json(400, {"error": "server", "message": "No cases selected to analyze."})
    if preset == "ask" and not question.strip():
        return send_json(400, {"error": "server", "message": "Type a question to ask."})

    # Auto-detail: make sure every case has description + timeline for full context.
    async def with_detail(c: dict) -> dict:
        return {**c, "detail": await get_case_detail(c, ["description", "timeline"])}

    cases = await asyncio.gather(*(with_detail(c) for c in rows))

    async def gen() -> AsyncIterator[str]:
        yield sse("start", {"count": len(cases)})
        q: asyncio.Queue = asyncio.Queue()
        cancel = asyncio.Event()
        handle = None
        finished = False

        def on_done(meta: dict) -> None:
            q.put_nowait(sse("done", meta))
            q.put_nowait(_END)

        def on_error(err: Any) -> None:
            q.put_nowait(sse("error", {"kind": getattr(err, "kind", "failed"), "message": str(err)}))
            q.put_nowait(_END)

        try:
            try:
                handle = analyze_cases(
                    {"preset": preset, "question": question, "cases": cases, "cancel": cancel},
                    lambda text: q.put_nowait(sse("chunk", {"text": text})),
                    on_done,
                    on_error,
                )
            except Exception as e:  # noqa: BLE001 — e.g. an unknown preset
                on_error(e)
            async for frame in _drain(q, heartbeat=False):
                yield frame
            finished = True
        finally:
            if not finished:
                cancel.set()
                if handle is not None:
                    handle.kill()

    return _stream(gen())


def _workspace_incoming(body: dict) -> list:
    if isinstance(body.get("paths"), list):
        return body["paths"]
    if isinstance(body.get("path"), str) and body["path"]:
        return [body["path"]]
    return get_workspace_paths()


# Read-only analysis of the workspace — streams the report via SSE.
#
# The file cap is enforced HERE as well as in the UI — the browser's decision is
# not trusted, so a direct API call can't kick off a huge run either.
@route("POST", "/api/workspace/analyze")
async def handle_workspace_analyze(request: Request) -> Response:
    body = await read_body(request)

    if not claude_available():
        return send_json(400, {"error": "server", "message": CLAUDE_MISSING})

    try:
        trimmed = [t for t in ((p.strip() if isinstance(p, str) else "") for p in _workspace_incoming(body)) if t]
        abs_paths = [validate_workspace_path(p) for p in trimmed[:MAX_PATHS]]
        if not abs_paths:
            return send_json(400, {"error": "path", "message": "No workspace folder configured."})
        en = enumerate_workspaces(abs_paths)
    except Exception as e:  # noqa: BLE001
        return _path_error(e)

    mode = "file" if body.get("mode") == "file" else "case" if body.get("mode") == "case" else "directory"
    target: str | None = None
    target_folder: str | None = None
    scope: dict | None = None
    scope_input: dict | None = None

    if mode == "case":
        # The case scope is computed here, before the stream opens, so a missing
        # case or an empty selection is a normal JSON error. The cap is not
        # checked: the selection is already bounded by it.
        bb = bound_brief()
        if "error" in bb:
            return send_json(400, {"error": "case", "message": bb["error"]})
        await ensure_case_info(bb["brief"])
        scope = await compute_case_scope(bb["brief"], abs_paths)
        if not scope["files"]:
            terms = ", ".join(t["term"] for t in scope["terms"][:6]) or "none found"
            return send_json(
                400,
                {
                    "error": "no_match",
                    "message": f"No files in the workspace matched {bb['brief']['number']}'s keywords ({terms}). "
                    "Add the folder that holds this school's files in phase 2, or check the case's district code.",
                    "scope": scope,
                },
            )
        scope_input = to_scope_input(scope, bb["brief"])
    elif mode == "file":
        # Exact match against the enumeration — never join a raw name onto a path.
        # This is also what disposes of any "../" concern.
        target = body["file"] if isinstance(body.get("file"), str) else ""
        target_folder = body["folder"] if isinstance(body.get("folder"), str) else None
        hit = next(
            (f for f in en["files"] if f["name"] == target and (not target_folder or f.get("folder") == target_folder)),
            None,
        )
        if not target or not hit:
            return send_json(
                400,
                {
                    "error": "server",
                    "message": f'"{target or ""}" is not one of the top-level source files in the workspace.',
                    "files": en["files"],
                },
            )
        target_folder = hit.get("folder")
    else:
        if en["count"] == 0:
            return send_json(
                400, {"error": "server", "message": "No top-level source or text files found in that folder."}
            )
        if en["overCap"] and not body.get("force"):
            return send_json(
                400,
                {
                    "error": "over_cap",
                    "message": f"That folder has {en['count']} top-level files — more than the {en['cap']}-file quick-analysis limit. "
                    "Choose to analyze all of them anyway, or pick a single file.",
                    "count": en["count"],
                    "cap": en["cap"],
                    "files": en["files"],
                },
            )

    count = 1 if mode == "file" else len(scope["files"]) if mode == "case" and scope else en["count"]

    async def gen() -> AsyncIterator[str]:
        yield sse(
            "start",
            {
                "paths": abs_paths,
                "mode": mode,
                "target": target or None,
                "targetFolder": target_folder or None,
                "count": count,
                "cap": en["cap"],
                "overCap": en["overCap"],
                "skipped": en["skipped"],
            },
        )
        if scope is not None:
            yield sse("scope", scope)

        q: asyncio.Queue = asyncio.Queue()
        cancel = asyncio.Event()
        handle = None
        finished = False

        def on_done(r: dict) -> None:
            meta = r.get("meta") or {}
            stored = r.get("stored")
            data = _pick(r, "costUsd", "totalTokens", "durationMs")
            data["saved"] = bool(stored)
            data["report"] = (stored or {}).get("report") or None
            data.update(_pick(meta, "truncated"))
            data["filesAnalyzed"] = len(meta.get("filesAnalyzed") or [])
            data["toolCalls"] = len(meta.get("toolCalls") or [])
            q.put_nowait(sse("done", data))
            q.put_nowait(_END)

        def on_error(err: Any, partial: dict | None = None) -> None:
            stored = (partial or {}).get("stored")
            q.put_nowait(
                sse(
                    "error",
                    {
                        "kind": getattr(err, "kind", "failed"),
                        "message": str(err),
                        "saved": bool(stored),
                        "report": (stored or {}).get("report") or None,
                    },
                )
            )
            q.put_nowait(_END)

        try:
            try:
                handle = analyze_workspace(
                    {
                        "paths": abs_paths,
                        "mode": mode,
                        "target": target,
                        "target_folder": target_folder,
                        "enumeration": en,
                        "proceeded_over_cap": mode == "directory" and en["overCap"] and bool(body.get("force")),
                        "case_scope": scope_input,
                        "cancel": cancel,
                    },
                    on_chunk=lambda text: q.put_nowait(sse("chunk", {"text": text})),
                    on_tool_use=lambda t: q.put_nowait(sse("tool", _pick(t, "name", "target"))),
                    on_done=on_done,
                    on_error=on_error,
                )
            except Exception as e:  # noqa: BLE001
                on_error(e, None)
            async for frame in _drain(q, heartbeat=True):
                yield frame
            finished = True
        finally:
            if not finished:
                cancel.set()
                if handle is not None:
                    handle.kill()

    return _stream(gen())


# Plan a fix for the bound case (Server-Sent Events).
#
# Read-only: the child gets Read/Glob/Grep and nothing else, so this route cannot
# modify a file no matter what the case text says. It streams the explanation,
# then a `done` event carrying the structured plan for review.
@route("POST", "/api/workspace/fix/plan")
async def handle_fix_plan(request: Request) -> Response:
    await read_body(request)
    return await _fix_plan_run()


# Revise a plan from the engineer's feedback. Same read-only run as planning,
# given the current plan and the note; the steps already carried out are kept
# verbatim and the new plan (a new id) continues after them.
@route("POST", "/api/workspace/fix/revise")
async def handle_fix_revise(request: Request) -> Response:
    body = await read_body(request)
    id = body["id"] if isinstance(body.get("id"), str) else ""
    if not id:
        return send_json(400, {"error": "server", "message": "No plan id given."})
    return await _fix_plan_run(revise={"id": id, "feedback": body.get("feedback")})


async def _fix_plan_run(revise: dict | None = None) -> Response:
    if not claude_available():
        return send_json(400, {"error": "server", "message": CLAUDE_MISSING})

    number = get_bound_case()
    if not number:
        return send_json(400, {"error": "server", "message": "No case is bound. Pick one in phase 1 first."})
    brief = load_brief(number)
    if not brief:
        return send_json(
            400,
            {
                "error": "server",
                "message": f"{number} is bound but nothing is stored for it. Search for it in phase 1 and pick it again to fetch the details.",
            },
        )
    await ensure_case_info(brief)

    try:
        abs_paths = _configured_abs()
        if not abs_paths:
            return send_json(400, {"error": "path", "message": "No workspace folder configured."})
        # Includes the case analysis's selected subfolder files, so they're editable.
        en = editable_enumeration(abs_paths, number)
    except Exception as e:  # noqa: BLE001
        return _path_error(e)

    if not en["count"]:
        return send_json(
            400,
            {"error": "server", "message": "No top-level source files in the workspace, so there is nothing to fix."},
        )

    prior: dict | None = None
    feedback = ""
    if revise:
        prior = load_plan(revise["id"])
        if prior and prior.get("caseNumber") != number:
            return send_json(400, {"error": "fix", "message": "That plan is for a different case than the one bound."})
        try:
            feedback = check_revision_request(prior, revise.get("feedback"))
        except FixPlanError as e:
            return send_json(400, {"error": "fix", "message": str(e)})
        # Files earlier steps created are editable by the revision too.
        en = with_created_files(en, prior)
        # The model sees which edits still match the files as they are now.
        prior = recheck_plan(prior, en, abs_paths)

    # The stored workspace analysis is the planner's map: it says what each file
    # is for, so the run spends its budget reading the right files rather than
    # rediscovering the layout. Staleness is passed through so it can be weighed
    # rather than silently trusted.
    #
    # The case-scoped analysis for this case wins when there is one: it was built
    # from exactly the files this case touches.
    case_stored = load_analysis_for(abs_paths, "case", number)
    stored = case_stored or load_analysis_for(abs_paths, "directory")
    analysis_stale = False
    if case_stored:
        analysis_stale = is_case_analysis_stale(case_stored["meta"], brief.get("fetchedAt"))
    elif stored:
        try:
            analysis_stale = is_stale(stored["meta"], enumerate_workspaces(abs_paths))
        except Exception:  # noqa: BLE001 — enumeration already succeeded above; treat as current
            pass
    smeta = stored["meta"] if stored else None

    async def gen() -> AsyncIterator[str]:
        yield sse(
            "start",
            {
                "caseNumber": brief["number"],
                "caseSubject": brief.get("subject"),
                "paths": abs_paths,
                "files": en["count"],
                "hasAnalysis": bool(stored),
                "analysisGenerated": (smeta or {}).get("finishedAt") or None,
                "analysisStale": analysis_stale,
                "analysisFiles": len((smeta or {}).get("filesAnalyzed") or []),
                "analysisMode": (smeta or {}).get("mode") or None,
                "revising": (
                    {"id": prior["id"], "revision": int(prior.get("revision") or 1) + 1, "locked": len(locked_steps(prior))}
                    if prior
                    else None
                ),
            },
        )

        q: asyncio.Queue = asyncio.Queue()
        cancel = asyncio.Event()
        handle = None
        finished = False

        def on_done(r: dict) -> None:
            data = {"plan": r.get("plan"), "planError": r.get("planError") or None}
            data.update(_pick(r, "costUsd", "totalTokens", "durationMs"))
            q.put_nowait(sse("done", data))
            q.put_nowait(_END)

        def on_error(err: Any, _partial: str = "", salvaged: dict | None = None) -> None:
            # A timed-out or stopped run that already emitted its plan still has
            # something reviewable; flag it as incomplete rather than discarding it.
            q.put_nowait(
                sse(
                    "error",
                    {
                        "kind": getattr(err, "kind", "failed"),
                        "message": str(err),
                        "plan": salvaged,
                        "incomplete": bool(salvaged),
                    },
                )
            )
            q.put_nowait(_END)

        try:
            try:
                opts: dict[str, Any] = {
                    "paths": abs_paths,
                    "enumeration": en,
                    "brief": brief,
                    "analysis_stale": analysis_stale,
                    "cancel": cancel,
                }
                if prior:
                    opts["prior_plan"] = prior
                    opts["feedback"] = feedback
                if stored:
                    opts["analysis_markdown"] = stored["body"]
                    opts["analysis_generated"] = smeta.get("finishedAt")
                handle = plan_fix(
                    opts,
                    on_chunk=lambda text: q.put_nowait(sse("chunk", {"text": text})),
                    on_tool_use=lambda t: q.put_nowait(sse("tool", _pick(t, "name", "target"))),
                    on_done=on_done,
                    on_error=on_error,
                )
            except Exception as e:  # noqa: BLE001
                on_error(e, "", None)
            async for frame in _drain(q, heartbeat=True):
                yield frame
            finished = True
        finally:
            if not finished:
                cancel.set()
                if handle is not None:
                    handle.kill()

    return _stream(gen())


# ---------------------------------------------------------------------------
# App
# ---------------------------------------------------------------------------
app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)


@app.api_route(
    "/{full_path:path}",
    methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"],
    include_in_schema=False,
)
async def dispatch(request: Request, full_path: str) -> Response:
    path = request.url.path
    if path.startswith("/api/"):
        handler = ROUTES.get((request.method, path))
        if handler is None:
            return send_json(404, {"error": "not_found", "message": f"No API route {request.method} {path}"})
        try:
            return await handler(request)
        except Exception as e:  # noqa: BLE001 — the TS top-level .catch(sendError)
            return send_error(e)
    try:
        return serve_static(path)
    except Exception:  # noqa: BLE001
        return Response(content=b"Internal error", status_code=500)


def _open_browser(target: str) -> None:
    try:
        webbrowser.open(target)
    except Exception:  # noqa: BLE001 — best-effort
        pass


def main() -> None:
    import uvicorn

    target = f"http://{HOST}:{PORT}"

    class _Server(uvicorn.Server):
        async def startup(self, sockets: Any = None) -> None:
            await super().startup(sockets=sockets)
            if self.should_exit:
                return
            print(f"[creatio-app] Case Lookup running at {target}  (base={BASE_URL or 'unset'})", file=sys.stderr)
            print("[creatio-app] Press Ctrl+C to stop.", file=sys.stderr, flush=True)
            if os.environ.get("CREATIO_APP_NO_OPEN") != "1":
                _open_browser(target)

    config = uvicorn.Config(app, host=HOST, port=PORT, log_level="warning", access_log=False)
    _Server(config).run()


if __name__ == "__main__":
    main()
