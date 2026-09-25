"""The `.env` file: read it live, write it in place.

Two ways of reading, on purpose:

* :func:`load_env_into_process` runs once at import and copies `.env` into
  ``os.environ`` WITHOUT overriding anything already set — so a value the MCP
  client baked into its registration wins. Used for stable config (base URL,
  allowlist, row cap) that only changes with a restart.
* :func:`read_env_file` re-reads the file on every call, so a cookie refresh
  or a workspace path saved from the web app takes effect immediately.

Parsing rules (kept identical to the original app so both read one file the
same way): split on the first ``=``, trim, strip ONE pair of matching quotes,
skip blank and ``#`` lines. Inline ``# comments`` are NOT stripped.
"""

from __future__ import annotations

import os
import re

from .paths import ENV_PATH


def _parse(text: str) -> dict[str, str]:
    out: dict[str, str] = {}
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        key, sep, val = line.partition("=")
        if not sep:
            continue
        key, val = key.strip(), val.strip()
        if len(val) >= 2 and val[0] == val[-1] and val[0] in "\"'":
            val = val[1:-1]
        out[key] = val
    return out


def read_env_file() -> dict[str, str]:
    """Parse KEY=VALUE lines straight from `.env`. ``{}`` if it can't be read."""
    try:
        return _parse(ENV_PATH.read_text(encoding="utf-8"))
    except OSError:
        return {}


def write_env_file(updates: dict[str, str]) -> None:
    """Merge-write keys into `.env`, keeping comments, order and untouched keys.

    Keys in ``updates`` are replaced in place; new keys are appended. The file
    is written with LF line endings and exactly one trailing newline.
    """
    try:
        lines = ENV_PATH.read_text(encoding="utf-8").splitlines()
    except OSError:
        lines = []
    remaining = dict(updates)
    out: list[str] = []
    for line in lines:
        trimmed = line.strip()
        key, sep, _ = trimmed.partition("=")
        key = key.strip()
        if trimmed and not trimmed.startswith("#") and sep and key in remaining:
            out.append(f"{key}={remaining.pop(key)}")
        else:
            out.append(line)
    out.extend(f"{k}={v}" for k, v in remaining.items())
    while out and out[-1] == "":
        out.pop()
    with open(ENV_PATH, "w", encoding="utf-8", newline="\n") as f:
        f.write("\n".join(out) + "\n")


def env_first(name: str) -> str:
    """A non-empty process environment value wins; otherwise the `.env` file."""
    v = os.environ.get(name)
    if v:
        return v.strip()
    return read_env_file().get(name, "").strip()


def clamp_int(raw: str | None, default: int, lo: int, hi: int) -> int:
    """Leading-integer parse like JS ``parseInt`` ("12abc" → 12), then clamp."""
    m = re.match(r"\s*([+-]?\d+)", str(raw)) if raw not in (None, "") else None
    if not m:
        return default
    return max(lo, min(hi, int(m.group(1))))


def load_env_into_process() -> None:
    """Copy `.env` into ``os.environ`` without overriding existing values."""
    for k, v in read_env_file().items():
        os.environ.setdefault(k, v)


load_env_into_process()
