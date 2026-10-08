"""Developers tab: the admin adds developers from inside their own app.

Only apps started with ``CCL_ADMIN=1`` (Terraform sets it for names in the
infra repo's ``admins``) show the tab or answer ``/api/admin/*``. Behind the
router only the signed-in admin reaches their own app, so nobody else can.

Adding a developer means creating Azure resources, which the app has no rights
to do on its own. So the admin signs in to Azure here once per app session
(device code, their own account), and the app runs the infra repo's Terraform
(baked into the image at ``CCL_INFRA_DIR``) as them:

1. The developer list lives in Key Vault (secret ``developers-config``), which
   main.tf reads, so the tab and the admin's PC always see the same list.
2. Add writes the new list, runs ``terraform plan`` and applies it only if the
   plan just creates that developer's resources and updates the router and the
   sign-in gate. Anything else (say this image's main.tf is older than the
   deployed one) is refused and the list is put back; apply from the PC then.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import shutil
import tempfile
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

CONFIG_SECRET = "developers-config"
NAME_RE = re.compile(r"^[a-z][a-z0-9]{0,11}$")
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
CIDR_RE = re.compile(r"^\d{1,3}(\.\d{1,3}){3}(/\d{1,2})?$")
_DEVICE_RE = re.compile(r"(https://\S+devicelogin\S*).*?code\s+([A-Z0-9-]{6,})", re.S)


class AdminError(Exception):
    pass


def enabled() -> bool:
    return os.environ.get("CCL_ADMIN") == "1"


def _cfg(key: str) -> str:
    v = os.environ.get(key, "")
    if not v:
        raise AdminError(f"{key} isn't set on this app.")
    return v


async def _run(*args: str, cwd: str | None = None, env: dict[str, str] | None = None,
               stdin: bytes | None = None) -> tuple[int, str]:
    proc = await asyncio.create_subprocess_exec(
        *args, cwd=cwd, env={**os.environ, **(env or {})},
        stdin=asyncio.subprocess.PIPE if stdin is not None else asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
    out, _ = await proc.communicate(stdin)
    return proc.returncode or 0, out.decode("utf-8", "replace")


# ---------------------------------------------------------------------------
# Azure sign-in (device code, the admin's own account)
# ---------------------------------------------------------------------------
_login: asyncio.subprocess.Process | None = None


async def azure_account() -> str | None:
    """The signed-in Azure user, or None."""
    if not shutil.which("az"):
        return None
    code, out = await _run("az", "account", "show", "--query", "user.name", "-o", "tsv")
    return out.strip() if code == 0 and out.strip() else None


async def start_azure_login(timeout_s: float = 60) -> dict[str, str]:
    """Start ``az login --use-device-code``; return the page and code to enter."""
    global _login
    if not shutil.which("az"):
        raise AdminError("The Azure CLI isn't installed in this image.")
    if _login and _login.returncode is None:
        _login.kill()
    _login = proc = await asyncio.create_subprocess_exec(
        "az", "login", "--use-device-code", "--tenant", _cfg("CCL_ADMIN_TENANT"), "-o", "none",
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT, stdin=asyncio.subprocess.DEVNULL)
    buf = ""
    try:
        async with asyncio.timeout(timeout_s):
            while proc.stdout and (line := await proc.stdout.readline()):
                buf += line.decode("utf-8", "replace")
                if m := _DEVICE_RE.search(buf):
                    asyncio.create_task(_finish_login(proc))
                    return {"url": m.group(1).rstrip("."), "code": m.group(2)}
    except TimeoutError:
        pass
    proc.kill()
    raise AdminError(f"Azure didn't show a sign-in code. {buf.strip()[-300:]}")


async def _finish_login(proc: asyncio.subprocess.Process) -> None:
    if proc.stdout:
        await proc.stdout.read()
    if await proc.wait() == 0:
        await _run("az", "account", "set", "--subscription", _cfg("CCL_ADMIN_SUBSCRIPTION"))


# ---------------------------------------------------------------------------
# The developer list (Key Vault secret read by main.tf)
# ---------------------------------------------------------------------------
async def read_config() -> dict[str, Any]:
    code, out = await _run("az", "keyvault", "secret", "show", "--vault-name", _cfg("CCL_ADMIN_KEYVAULT"),
                           "-n", CONFIG_SECRET, "--query", "value", "-o", "tsv")
    if code != 0:
        raise AdminError(f"Couldn't read the developer list: {out.strip()[-300:]}")
    cfg = json.loads(out)
    cfg.setdefault("developers", {})
    cfg.setdefault("allowed_cidrs", [])
    return cfg


async def write_config(cfg: dict[str, Any]) -> None:
    # --file keeps the JSON off the command line and out of shell quoting
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8") as f:
        json.dump(cfg, f, indent=2, sort_keys=True)
        path = f.name
    try:
        code, out = await _run("az", "keyvault", "secret", "set", "--vault-name", _cfg("CCL_ADMIN_KEYVAULT"),
                               "-n", CONFIG_SECRET, "--file", path, "--encoding", "utf-8", "-o", "none")
    finally:
        os.unlink(path)
    if code != 0:
        raise AdminError(f"Couldn't save the developer list: {out.strip()[-300:]}")


def validate(name: str, emails: list[str], ip: str, cfg: dict[str, Any]) -> tuple[str, list[str], str]:
    name = (name or "").strip().lower()
    emails = sorted({e.strip().lower() for e in emails if e and e.strip()})
    ip = (ip or "").strip()
    if not NAME_RE.match(name) or name == "gate":
        raise AdminError("Name: lowercase letters and digits, starting with a letter, up to 12 characters (not \"gate\").")
    if name in cfg["developers"]:
        raise AdminError(f"{name} is already a developer.")
    if not emails or not all(EMAIL_RE.match(e) for e in emails):
        raise AdminError("Add at least one valid email (the one they use to log in to Creatio).")
    taken = {e: d for d, ids in cfg["developers"].items() for e in ids}
    if clash := [f"{e} ({taken[e]})" for e in emails if e in taken]:
        raise AdminError("Already used by another developer: " + ", ".join(clash))
    if ip:
        if not CIDR_RE.match(ip):
            raise AdminError("IP: like 203.0.113.10 (their public IP from https://api.ipify.org).")
        if "/" not in ip:
            ip += "/32"
    return name, emails, ip


def plan_problems(plan: dict[str, Any], name: str) -> list[str]:
    """Changes in a `terraform show -json` plan that adding `name` shouldn't make."""
    allowed_updates = {"azurerm_container_app.router", "azurerm_container_app.gate"}
    bad = []
    for rc in plan.get("resource_changes", []):
        actions = rc.get("change", {}).get("actions", [])
        if actions in (["no-op"], ["read"]):
            continue
        addr = rc.get("address", "")
        if actions == ["create"] and f'["{name}"]' in addr:
            continue
        if actions == ["update"] and addr in allowed_updates:
            continue
        bad.append(f"{'/'.join(actions)} {addr}")
    return bad


# ---------------------------------------------------------------------------
# Add a developer: write the list, plan, check, apply (streamed)
# ---------------------------------------------------------------------------
_apply_lock = asyncio.Lock()


async def _stream(*args: str, cwd: str, env: dict[str, str]) -> AsyncIterator[tuple[str, Any]]:
    proc = await asyncio.create_subprocess_exec(*args, cwd=cwd, env={**os.environ, **env},
                                                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
                                                stdin=asyncio.subprocess.DEVNULL)
    assert proc.stdout
    while line := await proc.stdout.readline():
        text = line.decode("utf-8", "replace").rstrip()
        if text:
            yield "log", text
    yield "exit", await proc.wait()


async def add_developer(name: str, emails: list[str], ip: str) -> AsyncIterator[tuple[str, Any]]:
    """Yields ("progress", msg) / ("log", line); raises AdminError on failure."""
    if _apply_lock.locked():
        raise AdminError("Another change is being applied. Wait for it to finish.")
    async with _apply_lock:
        if not await azure_account():
            raise AdminError("Sign in to Azure first.")
        cfg = await read_config()
        name, emails, ip = validate(name, emails, ip, cfg)
        before = json.loads(json.dumps(cfg))
        cfg["developers"][name] = emails
        if ip and ip not in cfg["allowed_cidrs"]:
            cfg["allowed_cidrs"].append(ip)

        yield "progress", "Saving the developer list…"
        await write_config(cfg)
        applied = False
        work = Path(tempfile.mkdtemp(prefix="infra-"))
        try:
            shutil.copytree(_cfg("CCL_INFRA_DIR"), work, dirs_exist_ok=True)
            env = {"TF_IN_AUTOMATION": "1", "TF_INPUT": "0"}
            for msg, args in (("Preparing Terraform…", ("init", "-no-color")),
                              ("Planning the change…", ("plan", "-no-color", "-out", "tfplan")),
                              ("check", ()),
                              (f"Creating {name}'s app (2–3 minutes)…", ("apply", "-no-color", "tfplan"))):
                if msg == "check":
                    code, out = await _run("terraform", "show", "-json", "tfplan", cwd=str(work), env=env)
                    if code != 0:
                        raise AdminError("Couldn't read the plan.")
                    if bad := plan_problems(json.loads(out), name):
                        raise AdminError("Not applied: the plan would also change things it shouldn't ("
                                         + "; ".join(bad[:6]) + "). Apply from your PC instead.")
                    continue
                yield "progress", msg
                async for kind, val in _stream("terraform", *args, cwd=str(work), env=env):
                    if kind == "log":
                        yield "log", val
                    elif val != 0:
                        raise AdminError(f"terraform {args[0]} failed — see the log above.")
            applied = True
            yield "progress", f"Done. {name} can now log in with Creatio."
        finally:
            shutil.rmtree(work, ignore_errors=True)
            if not applied:
                await write_config(before)
