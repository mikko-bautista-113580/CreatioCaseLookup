"""Shared runner for the locally-installed Claude Code CLI.

We spawn ``claude -p`` in headless, streaming mode using the user's existing
Claude login (OAuth/subscription) — no API key needed.

INJECTION BOUNDARY — this docstring governs EVERY caller of :func:`run_claude`:

  The ``-p`` instruction and the ``--append-system-prompt`` text are fixed,
  app-authored strings. ALL untrusted content (Creatio case text, the user's
  free-text question, file names read off disk, anything a third party wrote)
  MUST be passed via ``spec.stdin``, never interpolated into argv or a shell
  string. A repo can legitimately contain a file called
  ``--dangerously-skip-permissions``; a file name must never become an argv token.

  ``cwd="isolated"`` spawns the child in a fresh empty temp directory so it
  cannot auto-load any repo's CLAUDE.md / settings, and grants no tools.
  That is the correct mode for any run that reads untrusted text.

  ``cwd={"dir": path}`` runs inside a real repo, which DOES load that repo's
  CLAUDE.md — verified: neither ``--safe-mode`` nor a full system-prompt
  override suppresses it. That is only safe for runs whose input has already
  been schema-validated and sanitized by the app, and whose tool set is clamped
  with ``tools.set`` — never for raw third-party prose.

  ``tools.set`` maps to ``--tools``, which removes the omitted tools from the
  child's tool SCHEMA rather than merely denying them. That is the strongest
  control available: a prompt-injected CLAUDE.md cannot call a tool that does
  not exist. ``tools.disallowed`` is the second layer, and is the only thing
  that stops a child from reading ``.env`` — keep the deny rules.

Callback style: :func:`run_claude` starts the run as an asyncio task on the
running loop and returns a :class:`RunHandle` immediately. Outcomes arrive via
plain sync callables (``on_chunk`` / ``on_tool_use`` / ``on_done`` /
``on_error``); exactly one of ``on_done`` / ``on_error`` fires. ``await
handle.wait()`` to block until the run has finished; ``handle.kill()`` (or
setting ``spec.cancel``) aborts it.
"""

from __future__ import annotations

import asyncio
import codecs
import json
import math
import os
import re
import shutil
import subprocess
import sys
import tempfile
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any, Callable, Literal

PermissionMode = Literal["dontAsk", "plan", "acceptEdits"]
SettingSource = Literal["user", "project", "local"]


@dataclass
class Tools:
    #: ``--tools``: the child's entire tool schema. The hard limit.
    set: list[str] | None = None
    #: ``--allowed-tools``: pre-approved, so ``dontAsk`` doesn't deny them.
    allowed: list[str] | None = None
    #: ``--disallowed-tools``: denied at the permission layer. Supports globs.
    disallowed: list[str] | None = None


@dataclass
class RunSpec:
    #: Fixed, app-authored ``-p`` text. Never user content.
    instruction: str
    #: Fixed, app-authored ``--append-system-prompt`` text. Never user content.
    system_prompt: str
    #: ALL untrusted content goes here.
    stdin: str
    #: ``"isolated"`` or ``{"dir": path}``.
    cwd: Any = "isolated"
    #: A :class:`Tools` or a dict with the same keys.
    tools: Tools | dict | None = None
    #: ``None`` → flag omitted; ``[]`` → ``--setting-sources ""`` (load none).
    setting_sources: list[str] | None = None
    safe_mode: bool = False
    add_dirs: list[str] = field(default_factory=list)
    permission_mode: str = "dontAsk"
    output_format: str = "stream-json"
    model: str | None = None
    #: ``--settings`` file. ``None`` → the app's own settings (see
    #: :func:`app_settings_file`); ``""`` → pass none.
    settings_file: str | None = None
    timeout_ms: int = 120_000
    #: Abort mechanism (TS ``AbortSignal``): set the event to cancel the run.
    cancel: asyncio.Event | None = None


class ClaudeCliError(Exception):
    """kind: ``"not_installed"`` | ``"not_logged_in"`` | ``"failed"``."""

    def __init__(self, message: str, kind: str = "failed") -> None:
        super().__init__(message)
        self.message = message
        self.kind = kind


@dataclass
class Launcher:
    cmd: str
    pre_args: list[str]
    via_shell: bool


_UNSET: Any = object()
_LAUNCHER: Launcher | None = _UNSET

_IS_WIN = sys.platform == "win32"
# windowsHide equivalent: never flash a console window for the child.
_CREATIONFLAGS = getattr(subprocess, "CREATE_NO_WINDOW", 0) if _IS_WIN else 0


def _reset_launcher_cache() -> None:
    """Forget the cached launcher (tests)."""
    global _LAUNCHER
    _LAUNCHER = _UNSET


def _resolve_claude_launcher() -> Launcher | None:
    global _LAUNCHER
    if _LAUNCHER is not _UNSET:
        return _LAUNCHER
    finder = "where" if _IS_WIN else "which"
    lines: list[str] = []
    try:
        r = subprocess.run(
            [finder, "claude"],
            capture_output=True,
            encoding="utf-8",
            errors="replace",
            creationflags=_CREATIONFLAGS,
        )
        lines = [s.strip() for s in re.split(r"\r?\n", r.stdout or "") if s.strip()]
    except Exception:
        pass  # fall through to None

    if not lines:
        _LAUNCHER = None
    elif not _IS_WIN:
        _LAUNCHER = Launcher(lines[0], [], False)
    else:
        # Windows refuses to spawn a .cmd shim without a shell, so prefer a real
        # .exe, then the packaged exe/cli.js, and only fall back to the shell.
        # No shell matters for more than quoting: kill() then reaches the real
        # process instead of a cmd.exe wrapper, so aborts don't orphan `claude`.
        exe_on_path = next((l for l in lines if re.search(r"\.exe$", l, re.I)), None)
        cmd_shim = next((l for l in lines if re.search(r"\.cmd$", l, re.I)), None)
        pkg_dir = (
            os.path.join(os.path.dirname(cmd_shim), "node_modules", "@anthropic-ai", "claude-code")
            if cmd_shim
            else None
        )
        shim_exe = os.path.join(pkg_dir, "bin", "claude.exe") if pkg_dir else None
        shim_cli = os.path.join(pkg_dir, "cli.js") if pkg_dir else None
        node = shutil.which("node")

        if exe_on_path:
            _LAUNCHER = Launcher(exe_on_path, [], False)
        elif shim_exe and os.path.exists(shim_exe):
            _LAUNCHER = Launcher(shim_exe, [], False)
        elif shim_cli and os.path.exists(shim_cli) and node:
            _LAUNCHER = Launcher(node, [shim_cli], False)
        else:
            _LAUNCHER = Launcher(cmd_shim or lines[0], [], True)
    return _LAUNCHER


def claude_available() -> bool:
    return bool(_resolve_claude_launcher())


def win_quote(a: str) -> str:
    """Quote one command-line token for the Windows shell. Wraps in double quotes
    and doubles any embedded quotes. Only ever applied to app-authored args."""
    return '"' + str(a).replace('"', '""') + '"'


DEFAULT_TIMEOUT_MS = 120_000


def tool_target(input: Any) -> str | None:
    """Best-effort extraction of the interesting target from a tool_use input."""
    if not input or not isinstance(input, dict):
        return None
    for k in ("file_path", "path", "pattern", "command", "url"):
        v = input.get(k)
        if isinstance(v, str) and v:
            return v
    return None


def _tools_field(tools: Tools | dict | None, name: str) -> list[str] | None:
    if tools is None:
        return None
    if isinstance(tools, dict):
        return tools.get(name)
    return getattr(tools, name, None)


def build_args(spec: RunSpec) -> list[str]:
    """The CLI argv (without the launcher's pre-args). Pure — see the module
    docstring: every token here is app-authored; untrusted text is on stdin."""
    output_format = spec.output_format or "stream-json"
    args = [
        "-p",
        spec.instruction,
        "--output-format",
        output_format,
        "--verbose",
        # Partial text deltas exist only in stream-json mode; the flag errors otherwise.
        *(["--include-partial-messages"] if output_format == "stream-json" else []),
        "--strict-mcp-config",  # no --mcp-config => all MCP servers disabled
        "--permission-mode",
        spec.permission_mode or "dontAsk",  # never blocks on an interactive prompt
        "--append-system-prompt",
        spec.system_prompt,
        "--no-session-persistence",  # don't litter ~/.claude with app-driven runs
    ]

    # --tools clamps the child's tool SCHEMA; the allow/deny lists layer on top.
    t_set = _tools_field(spec.tools, "set")
    t_allowed = _tools_field(spec.tools, "allowed")
    t_disallowed = _tools_field(spec.tools, "disallowed")
    if t_set:
        args += ["--tools", ",".join(t_set)]
    if t_allowed:
        args += ["--allowed-tools", ",".join(t_allowed)]
    if t_disallowed:
        args += ["--disallowed-tools", ",".join(t_disallowed)]
    if spec.setting_sources is not None:
        args += ["--setting-sources", ",".join(spec.setting_sources)]
    # Suppresses the target repo's hooks/plugins/skills/MCP — a repo's
    # .claude/settings.json can define hooks, i.e. arbitrary shell commands, which
    # is the one genuine code-execution path through a user-chosen directory.
    if spec.safe_mode:
        args.append("--safe-mode")
    for d in spec.add_dirs or []:
        args += ["--add-dir", d]
    if spec.model:
        args += ["--model", spec.model]
    if spec.settings_file:
        args += ["--settings", spec.settings_file]
    return args


# ---------------------------------------------------------------------------
# The app's own Claude settings
#
# This project's `.claude/settings.json` says how Claude should run here
# (model, effort, output style). The app's runs execute in the user's
# workspace folder with project settings off, so they'd never see it — so the
# relevant keys are handed over explicitly with --settings. Only these keys:
# a settings file can also define hooks (shell commands), and nothing that
# executes may ride along into a run that reads client-written case text.
# ---------------------------------------------------------------------------
APP_SETTINGS_PATH = Path(__file__).resolve().parent.parent / ".claude" / "settings.json"
APP_SETTINGS_KEYS = ("model", "effortLevel", "outputStyle")


def app_settings() -> dict:
    """The whitelisted keys from the app's `.claude/settings.json` ({} if none)."""
    try:
        with open(APP_SETTINGS_PATH, encoding="utf-8") as f:
            raw = json.load(f)
    except (OSError, ValueError):
        return {}
    if not isinstance(raw, dict):
        return {}
    return {k: raw[k] for k in APP_SETTINGS_KEYS if isinstance(raw.get(k), str) and raw[k].strip()}


def app_settings_file() -> str | None:
    """A filtered copy of the app's settings for --settings, or None when there
    are none. Written under `.analysis/` (git-ignored) and only when it changes."""
    s = app_settings()
    if not s:
        return None
    target = Path(__file__).resolve().parent.parent / ".analysis" / "claude-settings.json"
    body = json.dumps(s, indent=2)
    try:
        if not target.is_file() or target.read_text(encoding="utf-8") != body:
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(body, encoding="utf-8")
    except OSError:
        return None
    return str(target)


_TRIM_RE = re.compile(r"^[\s﻿]+|[\s﻿]+$")


def _trim(s: str) -> str:
    """JS ``String.prototype.trim`` (which also strips U+FEFF)."""
    return _TRIM_RE.sub("", s)


def _is_num(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


_TRANSIENT_RE = re.compile(r"overload|rate.?limit|429|529|usage limit|too many")
ABORT_MESSAGE = "Failed to run Claude: The operation was aborted"


class RunHandle:
    """Returned by :func:`run_claude`. ``kill()`` is sync and safe to call at
    any time (before spawn, mid-run, after finish); ``await wait()`` blocks
    until the run is over and its final callback has fired."""

    def __init__(self) -> None:
        self._task: asyncio.Task | None = None
        self._proc: asyncio.subprocess.Process | None = None
        self._killed = asyncio.Event() if _has_loop() else None

    def kill(self) -> None:
        if self._killed is not None:
            self._killed.set()
        p = self._proc
        if p is not None and p.returncode is None:
            try:
                p.kill()
            except Exception:
                pass

    async def wait(self) -> None:
        if self._task is not None:
            await asyncio.shield(self._task)


def _has_loop() -> bool:
    try:
        asyncio.get_running_loop()
        return True
    except RuntimeError:
        return False


def run_claude(
    spec: RunSpec,
    on_chunk: Callable[[str], None],
    on_done: Callable[[dict], None],
    on_error: Callable[[ClaudeCliError], None],
    on_tool_use: Callable[[dict], None] | None = None,
) -> RunHandle:
    """Run the Claude CLI, streaming text chunks via callbacks. Never raises —
    all outcomes are delivered through on_done / on_error. Must be called with
    an asyncio event loop running (the run is scheduled as a task on it).

    ``on_done`` receives a dict with camelCase keys (``costUsd``,
    ``totalTokens``, ``durationMs``, ``resultText``); absent values are omitted.
    ``on_tool_use`` receives ``{"name": str, "input": Any}``.
    """
    handle = RunHandle()
    launcher = _resolve_claude_launcher()
    if not launcher:
        on_error(
            ClaudeCliError(
                "The Claude CLI was not found. Install it (npm i -g @anthropic-ai/claude-code) and run `claude` once to log in.",
                "not_installed",
            )
        )
        return handle

    handle._task = asyncio.get_running_loop().create_task(
        _run(spec, launcher, handle, on_chunk, on_done, on_error, on_tool_use)
    )
    return handle


async def _run(
    spec: RunSpec,
    launcher: Launcher,
    handle: RunHandle,
    on_chunk: Callable[[str], None],
    on_done: Callable[[dict], None],
    on_error: Callable[[ClaudeCliError], None],
    on_tool_use: Callable[[dict], None] | None,
) -> None:
    if spec.settings_file is None:
        # The app's model / effort / output style, from its .claude/settings.json.
        spec = replace(spec, settings_file=app_settings_file() or "")
    args = build_args(spec)

    if spec.cwd == "isolated":
        try:
            cwd = tempfile.mkdtemp(prefix="creatio-run-")
        except Exception:
            cwd = tempfile.gettempdir()
    else:
        cwd = spec.cwd["dir"] if isinstance(spec.cwd, dict) else getattr(spec.cwd, "dir")

    timeout_ms = spec.timeout_ms or DEFAULT_TIMEOUT_MS
    killed = handle._killed
    assert killed is not None

    def aborted() -> bool:
        return killed.is_set() or (spec.cancel is not None and spec.cancel.is_set())

    # An already-aborted signal: Node emits the AbortError without running anything.
    if aborted():
        on_error(ClaudeCliError(ABORT_MESSAGE, "failed"))
        return

    # Prefer no shell everywhere — argv crosses as an array, no quoting layer,
    # so instructions containing quotes survive intact. The shell path is only
    # the last-resort .cmd fallback (see _resolve_claude_launcher); it stays
    # injection-safe because EVERY arg here is app-authored and individually
    # quoted, and all untrusted content is on stdin, never on the command line.
    argv = [*launcher.pre_args, *args]
    pipes = dict(
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        cwd=cwd,
        creationflags=_CREATIONFLAGS,
    )
    try:
        if launcher.via_shell:
            proc = await asyncio.create_subprocess_shell(
                " ".join(win_quote(a) for a in [launcher.cmd, *argv]), **pipes
            )
        else:
            proc = await asyncio.create_subprocess_exec(launcher.cmd, *argv, **pipes)
    except FileNotFoundError:
        on_error(ClaudeCliError("The Claude CLI could not be launched.", "not_installed"))
        return
    except Exception as e:  # noqa: BLE001
        on_error(ClaudeCliError(f"Failed to run Claude: {e}", "failed"))
        return
    handle._proc = proc
    if aborted():  # kill() raced the spawn
        try:
            proc.kill()
        except Exception:
            pass

    stderr_parts: list[str] = []
    buffer = ""
    raw_all: list[str] = []  # full stdout — needed for output_format json (see close)
    finished = False
    meta: dict[str, Any] = {}
    st = {"streamed_any": False, "result_text": "", "is_error": False, "error_info": ""}

    def handle_obj(obj: Any) -> None:
        if not isinstance(obj, dict):
            return
        t = obj.get("type")
        if t == "stream_event":
            ev = obj.get("event")
            if isinstance(ev, dict) and ev.get("type") == "content_block_delta":
                delta = ev.get("delta")
                if isinstance(delta, dict) and delta.get("type") == "text_delta":
                    st["streamed_any"] = True
                    on_chunk(delta.get("text") or "")
        elif t == "assistant" and on_tool_use:
            # Surface tool calls so callers can audit / display what was touched.
            msg = obj.get("message")
            content = msg.get("content") if isinstance(msg, dict) else None
            if isinstance(content, list):
                for block in content:
                    if (
                        isinstance(block, dict)
                        and block.get("type") == "tool_use"
                        and isinstance(block.get("name"), str)
                    ):
                        on_tool_use({"name": block["name"], "input": block.get("input")})
        elif t == "result":
            if isinstance(obj.get("result"), str):
                st["result_text"] = obj["result"]
            if obj.get("is_error"):
                st["is_error"] = True
            if obj.get("subtype") and obj.get("subtype") != "success":
                st["error_info"] = str(obj["subtype"])
            if obj.get("api_error_status"):
                st["error_info"] = f"API {obj['api_error_status']}"
            err = obj.get("error")
            if err:
                st["error_info"] = (
                    err
                    if isinstance(err, str)
                    else json.dumps(err, separators=(",", ":"), ensure_ascii=False)[:200]
                )
            if _is_num(obj.get("total_cost_usd")):
                meta["costUsd"] = obj["total_cost_usd"]
            usage = obj.get("usage")
            if isinstance(usage, dict) and usage.get("total_tokens"):
                meta["totalTokens"] = usage["total_tokens"]
            elif usage:
                u = usage if isinstance(usage, dict) else {}
                total = (u.get("input_tokens") or 0) + (u.get("output_tokens") or 0)
                if total:
                    meta["totalTokens"] = total
                else:
                    meta.pop("totalTokens", None)
            if _is_num(obj.get("duration_ms")):
                meta["durationMs"] = obj["duration_ms"]

    def handle_line(line: str) -> None:
        s = _trim(line)
        if not s:
            return
        try:
            obj = json.loads(s)
        except ValueError:
            return  # ignore non-JSON noise
        handle_obj(obj)

    async def pump_stdout() -> None:
        nonlocal buffer
        dec = codecs.getincrementaldecoder("utf-8")(errors="replace")
        assert proc.stdout is not None
        while True:
            chunk = await proc.stdout.read(65536)
            d = dec.decode(chunk, final=not chunk)
            if d:
                raw_all.append(d)
                buffer += d
                while not finished and (nl := buffer.find("\n")) != -1:
                    line, buffer = buffer[:nl], buffer[nl + 1 :]
                    handle_line(line)
            if not chunk:
                return

    async def pump_stderr() -> None:
        dec = codecs.getincrementaldecoder("utf-8")(errors="replace")
        assert proc.stderr is not None
        while True:
            chunk = await proc.stderr.read(65536)
            stderr_parts.append(dec.decode(chunk, final=not chunk))
            if not chunk:
                return

    async def feed_stdin() -> None:
        # Feed the untrusted content in via stdin, then close it. Always write,
        # even when empty — the CLI otherwise warns and stalls ~3s waiting for stdin.
        assert proc.stdin is not None
        try:
            proc.stdin.write(spec.stdin.encode("utf-8"))
            await proc.stdin.drain()
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
        finally:
            try:
                proc.stdin.close()
            except Exception:
                pass

    async def work() -> int | None:
        await asyncio.gather(feed_stdin(), pump_stdout(), pump_stderr())
        return await proc.wait()

    work_task = asyncio.ensure_future(work())
    abort_waiters = [asyncio.ensure_future(killed.wait())]
    if spec.cancel is not None:
        abort_waiters.append(asyncio.ensure_future(spec.cancel.wait()))

    def kill_child() -> None:
        try:
            if proc.returncode is None:
                proc.kill()
        except Exception:
            pass

    try:
        done, _ = await asyncio.wait(
            [work_task, *abort_waiters],
            timeout=timeout_ms / 1000,
            return_when=asyncio.FIRST_COMPLETED,
        )
    except asyncio.CancelledError:
        kill_child()
        work_task.cancel()
        raise
    finally:
        for w in abort_waiters:
            w.cancel()

    if work_task not in done:
        finished = True
        kill_child()
        if not done:  # timed out
            secs = math.floor(timeout_ms / 1000 + 0.5)
            on_error(ClaudeCliError(f"The run timed out after {secs}s.", "failed"))
        else:
            on_error(ClaudeCliError(ABORT_MESSAGE, "failed"))
        # Reap the child and let the pumps drain; never let this hang.
        try:
            await asyncio.wait_for(work_task, timeout=10)
        except BaseException:
            work_task.cancel()
        return

    try:
        code = work_task.result()
    except Exception as e:  # noqa: BLE001
        finished = True
        on_error(ClaudeCliError(f"Failed to run Claude: {e}", "failed"))
        return
    # The process died from kill()/cancel racing normal exit: report the abort.
    if aborted():
        finished = True
        on_error(ClaudeCliError(ABORT_MESSAGE, "failed"))
        return

    finished = True
    # Node reports a signal-terminated child as code null.
    exit_code: int | None = code if code is not None and code >= 0 else None
    if _trim(buffer):
        handle_line(buffer)

    # --output-format json emits ONE JSON document (an array of messages, or a
    # bare result object) rather than line-delimited events — the line parser
    # above sees an array, finds no "type", and extracts nothing. Re-parse the
    # whole capture and walk it.
    if spec.output_format == "json" and not st["result_text"]:
        try:
            doc = json.loads(_trim("".join(raw_all)))
            for item in doc if isinstance(doc, list) else [doc]:
                handle_obj(item)
        except ValueError:
            pass  # fall through to the normal error paths

    result_text: str = st["result_text"]
    is_error: bool = st["is_error"]
    error_info: str = st["error_info"]
    stderr = "".join(stderr_parts)

    # Some runs deliver the whole answer in the final `result` line rather than
    # as streamed deltas — surface it so the panel isn't blank.
    if not st["streamed_any"] and result_text and not is_error:
        on_chunk(result_text)

    if exit_code == 0 and not is_error:
        on_done({**meta, "resultText": result_text})
        return

    blob = f"{stderr} {error_info} {result_text}".lower()
    if "login" in blob or "not logged in" in blob or "authenticat" in blob or "/login" in blob:
        on_error(
            ClaudeCliError(
                "Claude is not logged in. Open a terminal, run `claude`, sign in, then try again.",
                "not_logged_in",
            )
        )
        return

    # Prefer the model's own error text; add a hint for the common transient cases.
    detail = _trim(error_info or result_text or stderr or "")
    hint = (
        " — Claude looks rate-limited/overloaded; wait a moment and retry."
        if _TRANSIENT_RE.search(blob)
        else ""
    )
    code_part = f" (exit {exit_code})" if exit_code is not None else ""
    on_error(
        ClaudeCliError(
            f"Run failed{code_part}: {detail[:400] if detail else 'no output from Claude'}{hint}",
            "failed",
        )
    )
