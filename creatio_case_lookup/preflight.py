"""Setup checklist: what this machine needs for each part of the app.

Runs two ways:

* ``python -m creatio_case_lookup.preflight`` — start-app.bat calls this before
  starting the server and prints the checklist in the console. Exit code 1
  means the app can't start (wrong Python, missing packages, port taken).
* ``GET /api/preflight`` — the Setup tab shows the same checks, re-run live.

Also owns the dependency stamp start-app.bat uses to reinstall packages when
pyproject.toml changes (``--deps-stale`` / ``--deps-mark``), so users who set
up before a new dependency was added still get it.

Imports only the standard library at module level: this must run even when
the app's packages are missing, since reporting that is its job.
"""

from __future__ import annotations

import asyncio
import hashlib
import importlib.util
import os
import shutil
import socket
import sys
from typing import Any

from .paths import ENV_PATH, PROJECT_ROOT

MIN_PYTHON = (3, 12)
REQUIRED_PACKAGES = {"fastapi": "fastapi", "uvicorn": "uvicorn", "httpx": "httpx", "mcp": "mcp", "openpyxl": "openpyxl"}

# Entity sets each tab reads. The allowlist has to include them.
TAB_ENTITIES: dict[str, list[str]] = {
    "Lookup": ["Case", "Activity", "SocialMessage", "Contact", "Account", "CaseFile"],
    "Lifecycle": ["CaseLifecycle"],
}
RECOMMENDED_ALLOWLIST = [e for es in TAB_ENTITIES.values() for e in es]

STAMP = PROJECT_ROOT / ".venv" / ".deps-sha256"
REINSTALL = "Run start-app.bat again; it reinstalls packages. Or run: .venv\\Scripts\\python -m pip install -e \".[login]\""


def _check(id: str, group: str, label: str, status: str, detail: str = "", fix: str = "", **extra: Any) -> dict[str, Any]:
    return {"id": id, "group": group, "label": label, "status": status, "detail": detail, "fix": fix, **extra}


def _env() -> dict[str, str]:
    """`.env` values, with the process environment winning (as the app does)."""
    from .env import read_env_file

    file = read_env_file()
    keys = ("CREATIO_BASE_URL", "CREATIO_ALLOWED_ENTITIES", "CREATIO_LOGIN", "CREATIO_PASSWORD",
            "CREATIO_ASPXAUTH", "CREATIO_BPMCSRF")
    return {k: (os.environ.get(k) or file.get(k) or "").strip() for k in keys}


# ---------------------------------------------------------------------------
# Individual checks
# ---------------------------------------------------------------------------
def check_python() -> dict[str, Any]:
    v = sys.version_info
    ver = f"{v.major}.{v.minor}.{v.micro}"
    if (v.major, v.minor) >= MIN_PYTHON:
        return _check("python", "Required", "Python 3.12 or newer", "ok", f"Python {ver}")
    return _check("python", "Required", "Python 3.12 or newer", "fail", f"Found Python {ver}.",
                  "Install Python 3.12+ from https://www.python.org, delete the .venv folder, and run start-app.bat again.")


def check_packages() -> dict[str, Any]:
    missing = [name for name, mod in REQUIRED_PACKAGES.items() if importlib.util.find_spec(mod) is None]
    if not missing:
        return _check("packages", "Required", "Python packages", "ok", ", ".join(REQUIRED_PACKAGES))
    return _check("packages", "Required", "Python packages", "fail", "Missing: " + ", ".join(missing), REINSTALL)


def check_env_file() -> dict[str, Any]:
    if ENV_PATH.is_file():
        return _check("env", "Connection", "Settings file (.env)", "ok", str(ENV_PATH))
    return _check("env", "Connection", "Settings file (.env)", "fail", "No .env file yet.",
                  "Run start-app.bat (it creates one from .env.example), or copy .env.example to .env.")


def check_base_url(env: dict[str, str]) -> dict[str, Any]:
    if env["CREATIO_BASE_URL"]:
        return _check("baseurl", "Connection", "Creatio address", "ok", env["CREATIO_BASE_URL"])
    return _check("baseurl", "Connection", "Creatio address", "fail", "CREATIO_BASE_URL isn't set.",
                  "Enter it in Settings → Creatio base URL (e.g. https://nelnet.creatio.com), then restart.", goto="settings")


def check_sign_in(env: dict[str, str]) -> dict[str, Any]:
    if env["CREATIO_ASPXAUTH"] and env["CREATIO_BPMCSRF"]:
        return _check("signin", "Connection", "Signed in to Creatio", "ok", "Session cookies are saved.")
    if env["CREATIO_LOGIN"] and env["CREATIO_PASSWORD"]:
        return _check("signin", "Connection", "Signed in to Creatio", "ok", "Using the service-account login in .env.")
    return _check("signin", "Connection", "Signed in to Creatio", "warn", "No session cookies saved.",
                  "Open Settings and click Log in with Creatio…", goto="settings")


async def check_connection(env: dict[str, str], timeout_s: float = 20.0) -> dict[str, Any]:
    label = "Creatio responds"
    if not env["CREATIO_BASE_URL"]:
        return _check("connection", "Connection", label, "skip", "Skipped: no Creatio address.")
    if check_sign_in(env)["status"] != "ok":
        # With nothing saved the client would try a blank service-account login
        # and report "invalid user name or password" — noise on top of the sign-in item.
        return _check("connection", "Connection", label, "skip", "Skipped until you sign in.")
    if importlib.util.find_spec("httpx") is None:
        return _check("connection", "Connection", label, "skip", "Skipped: packages missing.")
    from .creatio_client import test_connection

    try:
        r = await asyncio.wait_for(test_connection(), timeout_s)
    except asyncio.TimeoutError:
        return _check("connection", "Connection", label, "fail", f"No answer within {int(timeout_s)} seconds.",
                      "Check your network or VPN, then check again.")
    if r.get("ok"):
        return _check("connection", "Connection", label, "ok", "Read test succeeded.")
    return _check("connection", "Connection", label, "fail", str(r.get("error") or "Connection failed."),
                  "If the session expired, open Settings and click Log in with Creatio…", goto="settings")


def check_allowlist(env: dict[str, str]) -> dict[str, Any]:
    raw = env["CREATIO_ALLOWED_ENTITIES"]
    allowed = [s.strip() for s in raw.split(",") if s.strip()]
    if not allowed:
        return _check("allowlist", "Features", "Allowed entities", "warn",
                      "The allowlist is empty, so every Creatio entity is readable.",
                      "Set Allowed entities in Settings to the recommended list.",
                      goto="settings", missing=RECOMMENDED_ALLOWLIST, current=[])
    gaps = {tab: [e for e in ents if e not in allowed] for tab, ents in TAB_ENTITIES.items()}
    gaps = {t: g for t, g in gaps.items() if g}
    if not gaps:
        return _check("allowlist", "Features", "Allowed entities", "ok", ", ".join(allowed), current=allowed)
    missing = [e for g in gaps.values() for e in g]
    detail = "; ".join(f"{tab} needs {', '.join(g)}" for tab, g in gaps.items())
    return _check("allowlist", "Features", "Allowed entities", "warn", detail,
                  f"Add {', '.join(missing)} under Settings → Allowed entities, then restart.",
                  goto="settings", missing=missing, current=allowed)


def check_playwright() -> dict[str, Any]:
    label = "Browser login support (Playwright)"
    if importlib.util.find_spec("playwright") is not None:
        return _check("playwright", "Features", label, "ok", "Installed.")
    return _check("playwright", "Features", label, "warn",
                  "Not installed, so Log in with Creatio… won't work. Cookies can still be pasted by hand.",
                  REINSTALL)


def _browser_paths() -> list[str]:
    roots = [os.environ.get(k) for k in ("ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA")]
    rels = [r"Google\Chrome\Application\chrome.exe", r"Microsoft\Edge\Application\msedge.exe"]
    return [os.path.join(r, rel) for r in roots if r for rel in rels]


def check_browser() -> dict[str, Any]:
    label = "Chrome or Edge (for browser login)"
    found = [p for p in _browser_paths() if os.path.isfile(p)]
    found += [w for w in (shutil.which(n) for n in ("chrome", "msedge", "google-chrome", "microsoft-edge")) if w]
    if found:
        return _check("browser", "Features", label, "ok", found[0])
    return _check("browser", "Features", label, "warn", "Neither Chrome nor Edge was found.",
                  "Install Google Chrome or Microsoft Edge, or paste cookies by hand in Settings.")


def check_claude() -> dict[str, Any]:
    from .claude_run import claude_available

    label = "Claude Code CLI"
    if claude_available():
        return _check("claude", "Features", label, "ok", "Found on PATH.")
    return _check("claude", "Features", label, "warn",
                  "Not found, so AI analysis, fix plans and publishing artifacts are turned off.",
                  "Install it (npm i -g @anthropic-ai/claude-code), run `claude` once to sign in, then restart the app.")


def check_port(host: str, port: int) -> dict[str, Any]:
    label = f"Port {port} is free"
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.5)
        in_use = s.connect_ex((host, port)) == 0
    if not in_use:
        return _check("port", "Required", label, "ok")
    return _check("port", "Required", label, "fail",
                  f"Something is already running at http://{host}:{port} — probably another copy of this app.",
                  f"Use that copy (open http://{host}:{port}), or close it and run start-app.bat again. "
                  "To run a second copy, set CREATIO_APP_PORT to another port.")


# ---------------------------------------------------------------------------
# All together
# ---------------------------------------------------------------------------
async def run_checks(include_port: bool = False, host: str = "127.0.0.1", port: int = 3000,
                     include_connection: bool = True) -> dict[str, Any]:
    checks = [check_python(), check_packages()]
    if include_port:
        checks.append(check_port(host, port))
    checks.append(check_env_file())
    env = _env()
    checks += [check_base_url(env), check_sign_in(env)]
    if include_connection:
        checks.append(await check_connection(env))
    checks += [check_allowlist(env), check_playwright(), check_browser(), check_claude()]
    return {"checks": checks, "summary": summarize(checks)}


def summarize(checks: list[dict[str, Any]]) -> dict[str, Any]:
    fails = [c for c in checks if c["status"] == "fail"]
    warns = [c for c in checks if c["status"] == "warn"]
    blocking = [c for c in fails if c["group"] == "Required"]
    return {"ok": not fails and not warns, "fails": len(fails), "warnings": len(warns), "blocking": len(blocking)}


# ---------------------------------------------------------------------------
# Dependency stamp (start-app.bat)
# ---------------------------------------------------------------------------
def deps_hash() -> str:
    return hashlib.sha256((PROJECT_ROOT / "pyproject.toml").read_bytes()).hexdigest()


def deps_stale() -> bool:
    try:
        return STAMP.read_text(encoding="utf-8").strip() != deps_hash()
    except OSError:
        return True


def deps_mark() -> None:
    STAMP.write_text(deps_hash(), encoding="utf-8")


# ---------------------------------------------------------------------------
# Console output
# ---------------------------------------------------------------------------
_MARK = {"ok": "[ OK ]", "warn": "[WARN]", "fail": "[FAIL]", "skip": "[SKIP]"}


def format_report(result: dict[str, Any]) -> str:
    lines = ["", "Setup check", "-----------"]
    group = None
    for c in result["checks"]:
        if c["group"] != group:
            group = c["group"]
            lines.append(f"{group}:")
        detail = f" - {c['detail']}" if c["detail"] else ""
        lines.append(f"  {_MARK[c['status']]} {c['label']}{detail}")
        if c["fix"] and c["status"] in ("fail", "warn"):
            lines.append(f"         Fix: {c['fix']}")
    s = result["summary"]
    if s["blocking"]:
        lines.append(f"\n{s['blocking']} problem(s) stop the app from starting. Fix them and run start-app.bat again.")
    elif s["fails"] or s["warnings"]:
        lines.append(f"\nThe app will start. {s['fails'] + s['warnings']} item(s) need attention; "
                     "the Setup tab shows the same list.")
    else:
        lines.append("\nEverything is ready.")
    return "\n".join(lines) + "\n"


def main(argv: list[str] | None = None) -> int:
    args = sys.argv[1:] if argv is None else argv
    if "--deps-stale" in args:
        return 1 if deps_stale() else 0
    if "--deps-mark" in args:
        deps_mark()
        return 0
    port = int(os.environ.get("CREATIO_APP_PORT") or 3000)
    result = asyncio.run(run_checks(include_port=True, port=port))
    out = format_report(result)
    try:
        sys.stdout.write(out)
    except UnicodeEncodeError:  # a console that can't show some character
        sys.stdout.write(out.encode("ascii", "replace").decode("ascii"))
    sys.stdout.flush()
    return 1 if result["summary"]["blocking"] else 0


if __name__ == "__main__":
    sys.exit(main())
