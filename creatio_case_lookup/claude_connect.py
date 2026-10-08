"""Connect Claude from the app: runs ``claude setup-token`` for the user.

Where nobody can open a terminal (the Azure container), the Setup tab's
"Connect Claude" button drives the same flow a developer would run by hand:

1. :func:`start` runs ``claude setup-token`` in a pseudo-terminal (the CLI is an
   interactive terminal app) and returns the sign-in link it prints.
2. The user opens that link in their own browser, approves with their Claude
   account, and copies the code the page shows.
3. :func:`finish` types that code into the waiting CLI, reads the long-lived
   token (about 1 year) it prints, and saves it to `.env` as
   ``CLAUDE_CODE_OAUTH_TOKEN`` (and into this process), so every later
   ``claude -p`` runs on that user's own subscription.

Needs a POSIX pty, so it is offered only on Linux/macOS; on Windows the user
signs in with ``claude`` in a terminal instead. One flow at a time per app.
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import sys
import threading
import time

from .env import write_env_file

TOKEN_KEY = "CLAUDE_CODE_OAUTH_TOKEN"
IDLE_LIMIT_S = 600  # a started flow nobody finishes is stopped after this

_URL_RE = re.compile(r"https://\S+/oauth/authorize\?\S+")
_TOKEN_RE = re.compile(r"sk-ant-oat\d+-[A-Za-z0-9_-]{20,}")
# Escape sequences become spaces, not nothing: the CLI moves the cursor instead
# of printing spaces, and gluing words together could run text into the token.
_ANSI_RE = re.compile(r"\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;?<>=]*[A-Za-z~]|\x1b[()][0-9A-Za-z]|\x1b[=>78]")


class ConnectError(Exception):
    pass


def supported() -> bool:
    return sys.platform != "win32" and hasattr(os, "openpty")


def clean(text: str) -> str:
    return _ANSI_RE.sub(" ", text)


def find_url(text: str) -> str | None:
    m = _URL_RE.search(clean(text))
    return m.group(0) if m else None


def find_token(text: str) -> str | None:
    m = _TOKEN_RE.search(clean(text))
    return m.group(0) if m else None


class _Flow:
    """One running ``claude setup-token`` attached to a pty."""

    def __init__(self, exe: str) -> None:
        import fcntl
        import pty
        import struct
        import termios

        master, slave = pty.openpty()
        # Very wide, so the long sign-in link and the token are never wrapped
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 50, 1000, 0, 0))
        env = {**os.environ, "TERM": "xterm-256color", "BROWSER": "true"}
        env.pop("DISPLAY", None)  # don't open the sign-in page in the container's own browser
        env.pop(TOKEN_KEY, None)
        self.proc = subprocess.Popen([exe, "setup-token"], stdin=slave, stdout=slave, stderr=slave,
                                     env=env, start_new_session=True, close_fds=True)
        os.close(slave)
        self.master = master
        self.closed = False
        self.started = time.monotonic()
        self._out: list[str] = []
        self._lock = threading.Lock()
        threading.Thread(target=self._read, daemon=True).start()

    def _read(self) -> None:
        while True:
            try:
                data = os.read(self.master, 4096)
            except OSError:
                return
            if not data:
                return
            with self._lock:
                self._out.append(data.decode("utf-8", "replace"))

    def text(self) -> str:
        with self._lock:
            return "".join(self._out)

    def write(self, s: str) -> None:
        os.write(self.master, s.encode("utf-8"))

    def alive(self) -> bool:
        return self.proc.poll() is None

    def close(self) -> None:
        # Once only: the fd number may be reused after it is closed
        if self.closed:
            return
        self.closed = True
        if self.alive():
            self.proc.kill()
            try:
                self.proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                pass
        try:
            os.close(self.master)
        except OSError:
            pass


_flow: _Flow | None = None
_flow_lock = threading.Lock()


def _tail(text: str, n: int = 300) -> str:
    return re.sub(r"\s+", " ", clean(text)).strip()[-n:]


def _wait_for(flow: _Flow, find, timeout_s: float):
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        found = find(flow.text())
        if found:
            return found
        if not flow.alive():
            time.sleep(0.2)  # let the reader catch the last output
            return find(flow.text())
        time.sleep(0.2)
    return None


def start(timeout_s: float = 45) -> str:
    """Start ``claude setup-token`` and return the sign-in link it prints."""
    global _flow
    if not supported():
        raise ConnectError("Connect Claude isn't available on Windows. Open a terminal, run `claude`, and sign in.")
    exe = shutil.which("claude")
    if not exe:
        raise ConnectError("The Claude Code CLI isn't installed here.")
    with _flow_lock:
        if _flow:
            _flow.close()
        _flow = flow = _Flow(exe)
    timer = threading.Timer(IDLE_LIMIT_S, lambda: _stop_if(flow))
    timer.daemon = True
    timer.start()
    url = _wait_for(flow, find_url, timeout_s)
    if not url:
        _stop_if(flow)
        raise ConnectError(f"Claude didn't show a sign-in link. Output: {_tail(flow.text())}")
    return url


def finish(code: str, timeout_s: float = 60) -> None:
    """Type the code from the sign-in page into the waiting CLI and save the token."""
    code = (code or "").strip()
    if not code:
        raise ConnectError("Paste the code from the Claude sign-in page.")
    with _flow_lock:
        flow = _flow
    if not flow or not flow.alive():
        raise ConnectError("The sign-in expired. Click Connect Claude to start again.")
    before = len(flow.text())
    flow.write(code)
    time.sleep(0.3)
    flow.write("\r")
    token = _wait_for(flow, find_token, timeout_s)
    _stop_if(flow)
    if not token:
        raise ConnectError(f"Claude didn't accept the code. {_tail(flow.text()[before:])}".strip())
    write_env_file({TOKEN_KEY: token})
    os.environ[TOKEN_KEY] = token


def _stop_if(flow: _Flow) -> None:
    global _flow
    with _flow_lock:
        flow.close()
        if _flow is flow:
            _flow = None
