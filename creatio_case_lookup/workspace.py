"""Workspace directory: validation, top-level file enumeration, and the
`.analysis/` artifact store.

Pure filesystem + config. No Claude, no HTTP — those live in
analyze_workspace.py and server.py.

THREAT MODEL — read this before "hardening" anything here.
  The web app binds 127.0.0.1 only, is single-user, and already writes .env
  from its Settings screen. The user types their own path into their own tool.
  There is no attacker to defend against here, only mistakes. So: no jail, no
  allowlist, no canonicalization theatre. The path never becomes an argv token
  either — it becomes the analysis child's cwd — so there is no shell-injection
  surface.

  The two footguns that ARE worth preventing:
    1. Pointing at C:\\ or C:\\Windows and enumerating/analyzing something
       enormous. Handled by validate_workspace_path's root/denylist checks plus
       single-level (never recursive) enumeration and a dirent ceiling.
    2. Handing secrets to the analysis child. Handled here by never listing
       secret-bearing files, and in analyze_workspace.py by Read() deny rules.

ARTIFACTS live under `.analysis/` in THIS repo, never in the user's workspace
— writing into a directory the user might deploy or commit is its own hazard.

COMPATIBILITY: this module shares `.analysis/` with the TypeScript build, so
slugs (sha1 of the same normalized key), file layout, front matter and JSON
shapes (camelCase keys) are byte-for-byte the same. Everything that is JSON is
a plain dict. A few helpers reproduce JS semantics the store depends on:
``iso_now``/``iso_from_timestamp`` (``Date#toISOString``), ``parse_iso_ms``
(``Date.parse``), ``locale_key`` (``String#localeCompare`` ordering),
``js_round1`` (``Math.round(x * 10) / 10``) and ``js_parse_int``.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import re
import stat
import sys
import time
import unicodedata
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .env import read_env_file, write_env_file
from .paths import ANALYSIS_DIR

# `.analysis/` sits at the project root (see paths.py).
INDEX_PATH = ANALYSIS_DIR / "index.json"

WORKSPACE_ENV_KEY = "CREATIO_WORKSPACE_PATH"

# How many folders can make up one workspace.
#
# Stored as numbered .env keys (CREATIO_WORKSPACE_PATH, _2, _3) rather than one
# delimited value: a Windows path can legitimately contain most separators, and
# a bad split would silently point the analyzer at the wrong folder.
MAX_PATHS = 3

_WIN = sys.platform == "win32"


def _path_key(i: int) -> str:
    return WORKSPACE_ENV_KEY if i == 0 else f"{WORKSPACE_ENV_KEY}_{i + 1}"


# Default top-level file cap. Above this the caller must ask the user first.
DEFAULT_FILE_CAP = 10
# Files bigger than this would eat the child's context for one file.
MAX_FILE_BYTES = 512 * 1024
# Stop reading dirents past this — bounds any mistake the denylist missed.
MAX_ENTRIES = 2000


class WorkspacePathError(Exception):
    pass


# ---------------------------------------------------------------------------
# JS-compatibility helpers
# ---------------------------------------------------------------------------


def iso_from_timestamp(ts: float) -> str:
    """Epoch SECONDS → ``Date#toISOString()`` format (UTC, milliseconds, Z)."""
    return _iso_from_ms(math.floor(ts * 1000))


def _iso_from_ms(ms: int) -> str:
    dt = datetime.fromtimestamp(ms / 1000, tz=timezone.utc)
    dt = dt.replace(microsecond=(ms % 1000) * 1000)
    return dt.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def iso_now() -> str:
    """``new Date().toISOString()``."""
    return _iso_from_ms(time.time_ns() // 1_000_000)


def _mtime_ms(st: os.stat_result) -> int:
    """``stat.mtime.getTime()``: Node builds the Date from ``sec * 1e3 + nsec / 1e6``
    and ROUNDS to whole milliseconds — reproduced with the same float operations."""
    sec, nsec = divmod(st.st_mtime_ns, 1_000_000_000)
    return math.floor(sec * 1000 + nsec / 1e6 + 0.5)


def _mtime_iso(st: os.stat_result) -> str:
    return _iso_from_ms(_mtime_ms(st))


def now_ms() -> int:
    """``Date.now()``."""
    return time.time_ns() // 1_000_000


def parse_iso_ms(s: Any) -> float | None:
    """A forgiving ``Date.parse``: epoch ms, or None where JS gives NaN.

    Handles the ISO strings this app writes (``...Z``) and the local-time
    ``YYYY-MM-DD HH:MM:SS.ffffff`` the Azure CLI prints. Like JS, a date-only
    string is UTC and a date-time without an offset is local time.
    """
    if not isinstance(s, str):
        return None
    t = s.strip()
    if not t:
        return None
    try:
        if re.fullmatch(r"\d{4}-\d{2}-\d{2}", t):
            return datetime.fromisoformat(t).replace(tzinfo=timezone.utc).timestamp() * 1000
        # fromisoformat accepts at most 6 fractional digits.
        t2 = re.sub(r"(\.\d{6})\d+", r"\1", t)
        dt = datetime.fromisoformat(t2)
    except ValueError:
        return None
    return dt.timestamp() * 1000


def js_parse_int(raw: Any) -> int | None:
    """``parseInt(raw, 10)``: leading integer or None (JS NaN)."""
    m = re.match(r"\s*([+-]?\d+)", str(raw or ""))
    return int(m.group(1)) if m else None


def js_round1(x: float) -> float | int:
    """``Math.round(x * 10) / 10`` (half rounds up, like JS).

    Integral results come back as int so JSON output matches JS ("12", not "12.0").
    """
    r = math.floor(x * 10 + 0.5) / 10
    return int(r) if r == int(r) else r


def js_round(x: float) -> float | int:
    """``Math.round(x)``."""
    return int(math.floor(x + 0.5))


# ICU root collation order for printable ASCII, as Node's localeCompare sorts it
# (measured: whitespace, punctuation, symbols, digits, then letters a<A<b<B…).
_ICU_ASCII = " _-,;:!?.'\"()[]{}@*/\\&#%`^+<=>|~$0123456789abcdefghijklmnopqrstuvwxyz"
_ICU_RANK = {c: i for i, c in enumerate(_ICU_ASCII)}
_WS_CTRL = "\t\n\x0b\x0c\r"


def _collate_char(c: str) -> tuple[int, int, int]:
    """(primary, secondary, tertiary) weights for one character."""
    if c in _WS_CTRL:
        return (-1, 0, 0)
    low = c.lower()
    if low in _ICU_RANK and len(low) == 1:
        return (_ICU_RANK[low], 0, 1 if c != low else 0)
    base = unicodedata.normalize("NFD", c)
    b0 = base[0].lower() if base else c
    if b0 in _ICU_RANK:
        return (_ICU_RANK[b0], 1 if len(base) > 1 else 0, 1 if base[0] != base[0].lower() else 0)
    return (1000 + ord(low[0]), 0, 1 if c != low else 0)


def locale_key(s: str) -> tuple:
    """Sort key approximating ``a.localeCompare(b)`` (ICU root, multi-level)."""
    ws = [_collate_char(c) for c in str(s)]
    return (tuple(w[0] for w in ws), tuple(w[1] for w in ws), tuple(w[2] for w in ws))


def js_extname(name: str) -> str:
    """``path.extname`` — '' for dotfiles and names without a dot."""
    base = re.split(r"[\\/]", str(name))[-1]
    if base == "..":
        return ""
    i = base.rfind(".")
    if i <= 0:
        return ""
    return base[i:]


# JS `String#trimEnd` whitespace (includes \uFEFF, unlike str.rstrip()).
_JS_WS = " \t\n\x0b\x0c\r\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"


def _scandir(path: str | os.PathLike) -> list[os.DirEntry]:
    """Directory entries in Node's order: OS order on Windows, byte-sorted elsewhere
    (libuv's scandir sorts on POSIX)."""
    with os.scandir(path) as it:
        entries = list(it)
    if not _WIN:
        entries.sort(key=lambda e: os.fsencode(e.name))
    return entries


def _is_link(e: os.DirEntry) -> bool:
    """Node reports symlinks AND junctions as symbolic links, never as directories."""
    try:
        return e.is_symlink() or (hasattr(e, "is_junction") and e.is_junction())
    except OSError:
        return False


def _entry_is_dir(e: os.DirEntry) -> bool:
    try:
        return not _is_link(e) and e.is_dir(follow_symlinks=False)
    except OSError:
        return False


def _entry_is_file(e: os.DirEntry) -> bool:
    try:
        return not _is_link(e) and e.is_file(follow_symlinks=False)
    except OSError:
        return False


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------


def get_workspace_paths() -> list[str]:
    """The configured workspace folders, read LIVE from the .env file (not
    os.environ) so a save from the Workspace tab takes effect without restarting
    the app — same rationale as the SSO cookies in creatio_client.py.

    Returns [] when nothing is configured. Blank slots are dropped, so
    ["", "C:\\b", ""] collapses to ["C:\\b"].
    """
    env = read_env_file()
    out: list[str] = []
    for i in range(MAX_PATHS):
        v = (env.get(_path_key(i)) or "").strip()
        if v:
            out.append(v)
    return out


def get_workspace_path() -> str:
    """The first configured folder — the one the analyzer uses as its cwd."""
    paths = get_workspace_paths()
    return paths[0] if paths else ""


def set_workspace_paths(paths: list[str]) -> None:
    """Replace the configured folders. Always writes all MAX_PATHS keys so removing
    a folder actually clears its slot rather than leaving a stale value behind."""
    updates: dict[str, str] = {}
    for i in range(MAX_PATHS):
        updates[_path_key(i)] = (paths[i] if i < len(paths) else "") or ""
    write_env_file(updates)


def file_cap() -> int:
    raw = (read_env_file().get("CREATIO_WORKSPACE_FILE_CAP") or "").strip()
    n = js_parse_int(raw) if raw else None
    if n is None:
        return DEFAULT_FILE_CAP
    return max(1, min(200, n))


# ---------------------------------------------------------------------------
# Path validation
# ---------------------------------------------------------------------------


def _denylisted_exactly(abs_path: str) -> str | None:
    """Folders a user almost certainly didn't mean to analyze. Compared against the
    canonical path itself (not its children) so `C:\\Users\\me\\projects` is fine
    while `C:\\Users\\me` is not."""
    home = re.sub(r"[\\/]+$", "", os.environ.get("USERPROFILE") or os.environ.get("HOME") or "")
    exact: list[str] = []
    if home:
        exact.append(home)
        for d in ("Downloads", "Desktop", "Documents", "OneDrive"):
            exact.append(os.path.join(home, d))
    lower = abs_path.lower()
    for e in exact:
        if e and lower == e.lower():
            return e
    return None


# System trees that are never a project — matched as a prefix.
DENY_PREFIXES = [
    "c:\\windows",
    "c:\\program files",
    "c:\\program files (x86)",
    "c:\\programdata",
    "c:\\$recycle.bin",
    "/usr",
    "/etc",
    "/bin",
    "/sbin",
    "/system",
    "/library",
]

# Path segments that mean "you pointed at build output or a dependency tree".
DENY_SEGMENTS = {"node_modules", ".git"}


def _resolve(p: str) -> str:
    """``path.resolve`` for one argument: absolute, normalized, no trailing separator
    (except a root)."""
    return os.path.abspath(os.path.normpath(p)) if p else os.getcwd()


def _root_of(abs_path: str) -> str:
    """``path.parse(abs).root``."""
    if _WIN:
        drive, rest = os.path.splitdrive(abs_path)
        return drive + (rest[0] if rest[:1] in ("\\", "/") else "")
    return "/" if abs_path.startswith("/") else ""


def validate_workspace_path(raw: str) -> str:
    """Validate and canonicalize a user-typed absolute directory path.
    Raises WorkspacePathError with a message meant to be shown to the user verbatim."""
    inp = (raw or "").strip()
    if not inp:
        raise WorkspacePathError("Enter the folder you're working in.")

    # These characters would corrupt the KEY=VALUE line in .env.
    if re.search(r"[\0\"'=#\r\n]", inp):
        raise WorkspacePathError(
            "Path contains a character that can't be stored in .env (quote, =, # or a line break)."
        )

    # On Windows require a drive letter. This is what rejects UNC (\\server\share),
    # extended (\\?\C:\...) and device (\\.\PIPE\...) paths, none of which this
    # tool supports.
    if _WIN and not re.match(r"[A-Za-z]:[\\/]", inp):
        raise WorkspacePathError(
            "Enter a full local path starting with a drive letter, e.g. C:\\projects\\myapp. "
            "Network (\\\\server) paths aren't supported."
        )
    if not _WIN and not os.path.isabs(inp):
        raise WorkspacePathError("Enter a full path starting with /.")

    # Canonicalize, and strip trailing separators so C:\x\ and C:\x slug alike.
    abs_path = _resolve(inp)
    root = _root_of(abs_path)
    if len(abs_path) > len(root):
        abs_path = re.sub(r"[\\/]+$", "", abs_path)

    root_bare = re.sub(r"[\\/]+$", "", root).lower()
    if abs_path.lower() == root.lower() or abs_path.lower() == root_bare:
        raise WorkspacePathError("That's a drive root. Pick a project folder inside it.")

    lower = abs_path.lower()
    for p in DENY_PREFIXES:
        if lower == p or lower.startswith(p + "\\") or lower.startswith(p + "/"):
            raise WorkspacePathError(
                f"{abs_path} is a system folder, not a project directory. Pick the folder you're working in."
            )
    if _denylisted_exactly(abs_path):
        raise WorkspacePathError(
            f"{abs_path} is too broad to analyze. Pick the specific project folder inside it."
        )
    for seg in re.split(r"[\\/]", abs_path):
        if seg.lower() in DENY_SEGMENTS:
            raise WorkspacePathError(
                f'That path goes through "{seg}", which isn\'t source you\'d edit. Pick the project folder itself.'
            )

    # Stat AND enumerate here, so a folder that stats but won't list fails now —
    # at Save time, with a clear message — rather than mid-stream during analysis.
    try:
        if not os.path.isdir(abs_path):
            os.stat(abs_path)  # raises when missing
            raise WorkspacePathError("That's a file, not a folder. Enter the folder that contains it.")
        os.listdir(abs_path)
    except WorkspacePathError:
        raise
    except FileNotFoundError:
        raise WorkspacePathError("That folder doesn't exist.") from None
    except PermissionError:
        raise WorkspacePathError("That folder can't be read by this app (permission denied).") from None
    except NotADirectoryError:
        raise WorkspacePathError("That's a file, not a folder. Enter the folder that contains it.") from None
    except OSError as e:
        raise WorkspacePathError(f"That folder couldn't be opened: {e}") from None

    return abs_path


# ---------------------------------------------------------------------------
# Enumeration
# ---------------------------------------------------------------------------

# Extensions treated as readable source/text. .cfm/.cfc matter — the FACTS SIS
# report templates this tool supports are ColdFusion.
TEXT_EXT = {
    ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".jsonc",
    ".md", ".markdown", ".txt", ".rst",
    ".css", ".scss", ".sass", ".less",
    ".html", ".htm", ".xml", ".xsl", ".xslt", ".svg",
    ".yml", ".yaml", ".toml", ".ini", ".cfg", ".conf", ".properties",
    ".sh", ".bash", ".zsh", ".bat", ".cmd", ".ps1", ".psm1",
    ".py", ".rb", ".pl", ".php", ".go", ".rs", ".java", ".kt", ".swift",
    ".c", ".h", ".cpp", ".hpp", ".cc", ".cs", ".cshtml", ".razor", ".vb",
    ".sql", ".cfm", ".cfc", ".jsp", ".asp", ".aspx",
    ".vue", ".svelte", ".astro",
    ".csv", ".tsv", ".graphql", ".gql", ".proto",
}

# Extensionless or dotfile names that are still text worth reading.
TEXT_NAMES = {
    "dockerfile", "makefile", "rakefile", "gemfile", "procfile", "brewfile",
    "license", "licence", "readme", "changelog", "authors", "notice", "codeowners",
    ".gitignore", ".gitattributes", ".editorconfig", ".npmrc", ".nvmrc",
    ".dockerignore", ".prettierrc", ".eslintrc", ".babelrc", ".browserslistrc",
}

# Files that may hold credentials. Counted, never listed, never sent to a child.
# Use SECRET_RE.search(name) (JS RegExp#test semantics).
SECRET_RE = re.compile(
    r"^\.env(?:\Z|\.)|\.(?:pem|key|pfx|p12|crt|cer|der|jks|keystore|ppk)\Z|^id_(?:rsa|dsa|ecdsa|ed25519)",
    re.IGNORECASE | re.ASCII,
)

# Directories that are build output, dependencies, or tooling state.
SKIP_DIRS = {
    ".git", "node_modules", "dist", "build", "out", "target", ".next", ".nuxt",
    ".svelte-kit", ".venv", "venv", "env", "__pycache__", ".pytest_cache",
    ".mypy_cache", ".tox", "bin", "obj", "coverage", ".cache", ".parcel-cache",
    ".vs", ".vscode", ".idea", ".gradle", "vendor", ".terraform", ".analysis",
    ".browser-profile",
}


def is_text_file(name: str) -> bool:
    lower = name.lower()
    if lower in TEXT_NAMES:
        return True
    ext = js_extname(lower)
    return bool(ext) and ext in TEXT_EXT


def _empty_skipped() -> dict:
    return {"binaries": 0, "oversized": 0, "secrets": 0, "unreadable": 0, "entriesTruncated": False}


def enumerate_workspace(dir: str) -> dict:
    """List the top-level source/text files of a directory.

    SINGLE LEVEL, NEVER RECURSIVE. That is the cap rule, and it's also what makes
    pointing at a huge tree cheap instead of catastrophic. Subdirectory names are
    returned for context only.

    `dir` must already have been through validate_workspace_path().
    Returns an EnumResult dict: {path, files, count, cap, overCap, dirs, skipped}.
    """
    files: list[dict] = []
    dirs: list[str] = []
    skipped = _empty_skipped()

    try:
        entries = _scandir(dir)
    except OSError as e:
        raise WorkspacePathError(f"That folder couldn't be listed: {e}") from None

    if len(entries) > MAX_ENTRIES:
        skipped["entriesTruncated"] = True
        entries = entries[:MAX_ENTRIES]

    for entry in entries:
        name = entry.name

        if _entry_is_dir(entry):
            if name.lower() not in SKIP_DIRS:
                dirs.append(name)
            continue
        if not _entry_is_file(entry) and not _is_link(entry):
            continue

        if SECRET_RE.search(name):
            skipped["secrets"] += 1
            continue
        if not is_text_file(name):
            skipped["binaries"] += 1
            continue

        try:
            st = os.stat(os.path.join(dir, name))
        except OSError:
            skipped["unreadable"] += 1
            continue
        if not stat.S_ISREG(st.st_mode):
            continue  # a symlink to a directory
        if st.st_size > MAX_FILE_BYTES:
            skipped["oversized"] += 1
            continue

        files.append({
            "name": name,
            "size": st.st_size,
            "mtime": _mtime_iso(st),
            "ext": js_extname(name).lower(),
        })

    files.sort(key=lambda f: locale_key(f["name"]))
    dirs.sort(key=locale_key)

    cap = file_cap()
    return {
        "path": dir,
        "files": files,
        "count": len(files),
        "cap": cap,
        "overCap": len(files) > cap,
        "dirs": dirs,
        "skipped": skipped,
    }


def enumerate_workspaces(dirs: list[str]) -> dict:
    """Enumerate up to MAX_PATHS folders as ONE workspace.

    The cap is applied to the TOTAL, not per folder — the point of the cap is
    "the analysis stays fast", and three folders of ten files each is thirty
    files to read however they're grouped.

    Each path must already have been through validate_workspace_path().
    Returns a MultiEnumResult dict: {folders, count, cap, overCap, files, skipped};
    every file in `files` carries the `folder` it came from.
    """
    folders = [enumerate_workspace(d) for d in dirs]
    files = [{**x, "folder": f["path"]} for f in folders for x in f["files"]]
    skipped = _empty_skipped()
    for f in folders:
        s = f["skipped"]
        skipped["binaries"] += s["binaries"]
        skipped["oversized"] += s["oversized"]
        skipped["secrets"] += s["secrets"]
        skipped["unreadable"] += s["unreadable"]
        skipped["entriesTruncated"] = skipped["entriesTruncated"] or s["entriesTruncated"]
    cap = file_cap()
    return {
        "folders": folders,
        "count": len(files),
        "cap": cap,
        "overCap": len(files) > cap,
        "files": files,
        "skipped": skipped,
    }


# ---------------------------------------------------------------------------
# Artifact store
#
# AnalysisMode: "directory" | "file" | "case". `case` is a case-scoped analysis:
# only the files the app ranked as related to one bound case (searched
# recursively). `target` is the SR number.
# AnalysisStatus: "complete" | "stopped" | "timeout".
#
# AnalysisMeta (the sidecar JSON) keys, as in TS: version, slug, path, paths,
# mode, target, startedAt, finishedAt, durationMs?, model?, cap, capExceeded,
# proceededOverCap, filesAnalyzed, dirsPresent, skipped, truncated, toolCalls,
# usage, status, report, selection?, terms?, briefFetchedAt?.
# ---------------------------------------------------------------------------


def _sha1_hex(s: str) -> str:
    return hashlib.sha1(s.encode("utf-8")).hexdigest()


def _norm_key(p: str) -> str:
    n = re.sub(r"[\\/]+$", "", _resolve(p))
    # Windows filesystems are case-insensitive, so C:\Foo and c:\foo are one
    # workspace and must produce one slug.
    return n.lower() if _WIN else n


def _slug_base(key: str, limit: int) -> str:
    base = re.sub(r"[^A-Za-z0-9]+", "-", key)
    base = re.sub(r"^-+|-+$", "", base)[:limit]
    return re.sub(r"-+$", "", base).lower()


def slug_for_path(abs_path: str) -> str:
    """Stable directory name for a workspace path: a readable prefix plus a hash so
    two different paths can never collide. Not reversible — the full path is
    recorded in index.json, analysis.json and the report's front matter."""
    key = _norm_key(abs_path)
    h = _sha1_hex(key)[:8]
    base = _slug_base(key, 60)
    return f"{base or 'workspace'}-{h}"


def slug_for_paths(paths: list[str]) -> str:
    """Slug for a workspace made of one or more folders. The readable prefix comes
    from the first folder; the hash covers the whole ordered list, so adding or
    removing a folder yields a different workspace rather than silently reusing
    the previous report.

    A single folder delegates to slug_for_path, so reports stored before
    multi-folder support still resolve."""
    if len(paths) <= 1:
        return slug_for_path(paths[0] if paths else "")
    norm = [_norm_key(p) for p in paths]
    h = _sha1_hex("\u0000".join(norm))[:8]
    base = _slug_base(norm[0], 48)
    return f"{base or 'workspace'}-plus{len(norm) - 1}-{h}"


def slug_for_file(name: str) -> str:
    """Stable file name for a single-file analysis within a workspace."""
    base = re.sub(r"[^A-Za-z0-9]+", "-", name)
    base = re.sub(r"^-+|-+$", "", base).lower()
    if len(base) <= 80:
        return base or "file"
    h = _sha1_hex(name)[:8]
    return f"{re.sub(r'-+$', '', base[:70])}-{h}"


def _rel_path(*parts: str) -> str:
    """Relative POSIX path, as stored in index.json and reported to callers."""
    return "/".join([".analysis", *parts])


def artifact_paths(meta: dict) -> dict:
    """Where one analysis lives. `meta` needs slug, mode and target.
    Returns {dir, md, json, relMd, relJson} (dir/md/json are absolute str paths)."""
    slug = meta["slug"]
    mode = meta.get("mode")
    target = meta.get("target")
    base = Path(ANALYSIS_DIR)
    if mode == "case":
        # The target is a validated SR number, so it's already a safe file name.
        n = target if re.fullmatch(r"SR\d{4,12}", target or "", re.ASCII) else slug_for_file(target or "case")
        d = base / slug / "cases"
        return {
            "dir": str(d),
            "md": str(d / f"{n}.md"),
            "json": str(d / f"{n}.json"),
            "relMd": _rel_path(slug, "cases", f"{n}.md"),
            "relJson": _rel_path(slug, "cases", f"{n}.json"),
        }
    if mode == "file":
        fs = slug_for_file(target or "file")
        d = base / slug / "files"
        return {
            "dir": str(d),
            "md": str(d / f"{fs}.md"),
            "json": str(d / f"{fs}.json"),
            "relMd": _rel_path(slug, "files", f"{fs}.md"),
            "relJson": _rel_path(slug, "files", f"{fs}.json"),
        }
    d = base / slug
    return {
        "dir": str(d),
        "md": str(d / "analysis.md"),
        "json": str(d / "analysis.json"),
        "relMd": _rel_path(slug, "analysis.md"),
        "relJson": _rel_path(slug, "analysis.json"),
    }


# ---------------------------------------------------------------------------
# Writing a file INTO a workspace folder
#
# This is the only path in the app that writes outside this repo other than an
# approved fix apply, so the rules are deliberately narrow.
#
# Raster images only. The bytes come from a Creatio attachment — uploaded by a
# CLIENT — and a workspace folder here holds ColdFusion templates that a server
# may execute. Dropping a client-supplied `.cfm`, `.bat` or `.exe` into it would
# be a genuine code-execution risk, so the extension allowlist is the control.
# `.svg` is excluded on purpose: it can carry script and gets rendered.
# ---------------------------------------------------------------------------

WRITABLE_IMAGE_EXT = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico"]


def sniff_image_type(b: bytes) -> dict | None:
    """Identify an image from its leading bytes → {ext: [...], label} or None.

    The extension allowlist only checks the NAME. These bytes come from a client
    upload, so the name proves nothing: without this, arbitrary content named
    `logo.png` would be written. Sniffing also catches the subtler case of
    renaming a .jpeg to .png, which produces a file whose extension lies about
    what is inside it.
    """
    b = bytes(b or b"")

    def at(i: int) -> int:
        return b[i] if i < len(b) else -1

    if at(0) == 0x89 and at(1) == 0x50 and at(2) == 0x4E and at(3) == 0x47:
        return {"ext": [".png"], "label": "PNG"}
    if at(0) == 0xFF and at(1) == 0xD8 and at(2) == 0xFF:
        return {"ext": [".jpg", ".jpeg"], "label": "JPEG"}
    if len(b) >= 6 and b[:3] == b"GIF":
        return {"ext": [".gif"], "label": "GIF"}
    if len(b) >= 12 and b[:4] == b"RIFF" and b[8:12] == b"WEBP":
        return {"ext": [".webp"], "label": "WebP"}
    if at(0) == 0x42 and at(1) == 0x4D:
        return {"ext": [".bmp"], "label": "BMP"}
    if at(0) == 0x00 and at(1) == 0x00 and at(2) == 0x01 and at(3) == 0x00:
        return {"ext": [".ico"], "label": "icon"}
    return None


# Bounds a single dropped-in asset.
MAX_ASSET_BYTES = 10 * 1024 * 1024


class WorkspaceWriteError(Exception):
    """`.code` is one of: folder, name, ext, exists, size, content, mismatch."""

    def __init__(self, message: str, code: str):
        super().__init__(message)
        self.code = code


def safe_asset_name(raw: str) -> str:
    """Reduce an attachment's name to a safe basename.

    Creatio filenames are client-supplied, so this keeps only the last path
    segment and a conservative character set — there is no path left to traverse
    with by the time it is joined onto a folder.
    """
    base = re.sub(r"^.*[\\/]", "", str(raw or "")).strip(_JS_WS)
    if not base or base == "." or base == "..":
        raise WorkspaceWriteError("That attachment has no usable file name.", "name")
    safe = re.sub(r"[^A-Za-z0-9._ -]+", "_", base)
    safe = re.sub(r"^[.]+", "", safe)
    if not safe:
        raise WorkspaceWriteError("That file name can't be used on disk.", "name")
    # Truncate the stem, never the extension — cutting the extension off would
    # make a long-named image look like a rejected file type.
    raw_ext = js_extname(safe)
    stem = safe[: len(safe) - len(raw_ext)] or "file"
    cleaned = stem[:100] + raw_ext
    ext = raw_ext.lower()
    if ext not in WRITABLE_IMAGE_EXT:
        raise WorkspaceWriteError(
            f"Only image files can be saved into a workspace folder ({', '.join(WRITABLE_IMAGE_EXT)}). "
            f'"{base}" is not one — open it in a new tab instead.',
            "ext",
        )
    return cleaned


def save_asset_to_workspace(
    folder: str,
    raw_name: str,
    data: bytes,
    *,
    allowed: list[str],
    overwrite: bool = False,
) -> dict:
    """Write an image into one of the configured workspace folders.

    Refuses to clobber silently: an existing file needs `overwrite`, and the
    original is copied into `.analysis/assets/` first so the replacement can be
    undone even when the folder isn't a git repository.

    Returns {path, name, backup?, overwrote}.
    """
    target = next((p for p in allowed if p.lower() == str(folder or "").lower()), None)
    if not target:
        raise WorkspaceWriteError("That folder isn't one of the configured workspace folders.", "folder")
    if not data:
        raise WorkspaceWriteError("The attachment came back empty.", "size")
    if len(data) > MAX_ASSET_BYTES:
        raise WorkspaceWriteError("That attachment is larger than 10 MB.", "size")

    # The name must match what the bytes actually are — see sniff_image_type().
    kind = sniff_image_type(data)
    if not kind:
        raise WorkspaceWriteError(
            "That attachment isn't a recognisable image (PNG, JPEG, GIF, WebP, BMP or icon), so it won't be written into a source folder.",
            "content",
        )

    name = safe_asset_name(raw_name)
    name_ext = js_extname(name).lower()
    if name_ext not in kind["ext"]:
        raise WorkspaceWriteError(
            f'That file is a {kind["label"]} image, so it can\'t be saved as "{name}". '
            f"Use {' or '.join(kind['ext'])} instead — an extension that doesn't match the contents breaks some viewers.",
            "mismatch",
        )

    dest = os.path.join(target, name)
    exists = os.path.exists(dest)

    if exists and not overwrite:
        raise WorkspaceWriteError(
            f'"{name}" already exists in that folder. Confirm to replace it — the current file is backed up first.',
            "exists",
        )

    backup: str | None = None
    if exists:
        stamp = re.sub(r"[:.]", "-", iso_now())
        backup = str(Path(ANALYSIS_DIR) / "assets" / f"{stamp}-{name}")
        os.makedirs(os.path.dirname(backup), exist_ok=True)
        with open(dest, "rb") as src, open(backup, "wb") as out:
            out.write(src.read())

    tmp = f"{dest}.tmp-{os.getpid()}-{now_ms()}"
    with open(tmp, "wb") as f:
        f.write(data)
    os.replace(tmp, dest)

    result: dict = {"path": dest, "name": name}
    if backup is not None:
        result["backup"] = backup
    result["overwrote"] = exists
    return result


def write_atomic(target: str | os.PathLike, body: str) -> None:
    """Write via a temp file + rename so a reader never sees a half-written file."""
    target = os.fspath(target)
    os.makedirs(os.path.dirname(target), exist_ok=True)
    tmp = f"{target}.tmp-{os.getpid()}-{now_ms()}"
    with open(tmp, "w", encoding="utf-8", newline="") as f:
        f.write(body)
    os.replace(tmp, target)


def _yaml_str(v: Any) -> str:
    """YAML single-quoted scalar. A Windows path contains `:` after the drive letter,
    which a bare YAML scalar reads as a mapping — so every path MUST be quoted
    this way or a consumer's YAML parse breaks."""
    return "'" + str(v).replace("'", "''") + "'"


def _front_matter(meta: dict) -> str:
    return "\n".join([
        "---",
        f"workspace: {_yaml_str(meta['path'])}",
        f"slug: {_yaml_str(meta['slug'])}",
        f"mode: {meta['mode']}",
        f"target: {_yaml_str(meta['target']) if meta.get('target') else 'null'}",
        f"generated: {_yaml_str(meta['finishedAt'])}",
        f"model: {_yaml_str(meta['model']) if meta.get('model') else 'null'}",
        f"files_analyzed: {len(meta.get('filesAnalyzed') or [])}",
        f"truncated: {'true' if meta.get('truncated') else 'false'}",
        f"status: {meta['status']}",
        "---",
        "",
    ])


def _json(obj: Any) -> str:
    return json.dumps(obj, indent=2, ensure_ascii=False)


def _read_index() -> dict:
    try:
        with open(INDEX_PATH, encoding="utf-8") as f:
            doc = json.load(f)
        if isinstance(doc, dict) and isinstance(doc.get("workspaces"), list):
            return doc
        raise ValueError("shape")
    except FileNotFoundError:
        return {"version": 1, "updatedAt": iso_now(), "workspaces": []}
    except (OSError, ValueError):
        # Corrupt index: move it aside rather than lose the reports it pointed at.
        # The reports themselves are the source of truth; the index is a convenience.
        try:
            os.replace(INDEX_PATH, Path(ANALYSIS_DIR) / f"index.corrupt-{now_ms()}.json")
        except OSError:
            pass
        return {"version": 1, "updatedAt": iso_now(), "workspaces": []}


def _upsert_index(meta: dict, paths: dict) -> None:
    doc = _read_index()
    entry = next((w for w in doc["workspaces"] if w.get("slug") == meta["slug"]), None)
    if entry is None:
        entry = {"slug": meta["slug"], "path": meta["path"], "paths": meta["paths"], "directory": None, "files": []}
        doc["workspaces"].append(entry)
    # Keep the original casing fresh.
    entry["path"] = meta["path"]
    entry["paths"] = meta["paths"]

    if meta["mode"] == "directory":
        entry["directory"] = {
            "report": paths["relMd"],
            "meta": paths["relJson"],
            "finishedAt": meta["finishedAt"],
            "fileCount": len(meta.get("filesAnalyzed") or []),
            "truncated": meta["truncated"],
            "status": meta["status"],
        }
    else:
        name = meta.get("target") or meta["mode"]
        row = {
            "name": name,
            "report": paths["relMd"],
            "meta": paths["relJson"],
            "finishedAt": meta["finishedAt"],
            "status": meta["status"],
            "truncated": meta["truncated"],
        }
        if meta["mode"] == "case":
            if not entry.get("cases"):
                entry["cases"] = []
            lst = entry["cases"]
        else:
            lst = entry.setdefault("files", [])
        i = next((k for k, f in enumerate(lst) if f.get("name") == name), -1)
        if i == -1:
            lst.append(row)
        else:
            lst[i] = row
        lst.sort(key=lambda f: locale_key(f.get("name", "")))

    doc["updatedAt"] = iso_now()
    doc["workspaces"].sort(key=lambda w: locale_key(w.get("path", "")))
    write_atomic(INDEX_PATH, _json(doc) + "\n")


def save_analysis(meta: dict, markdown: str) -> dict:
    """Persist one analysis: report, sidecar, then the index → {report, meta}.

    Order matters — index.json is written LAST so a crash can never leave the
    index pointing at a report that isn't on disk.
    """
    paths = artifact_paths(meta)
    stored = {**meta, "report": paths["relMd"]}
    write_atomic(paths["md"], _front_matter(stored) + markdown.rstrip(_JS_WS) + "\n")
    write_atomic(paths["json"], _json(stored) + "\n")
    _upsert_index(stored, paths)
    return {"report": paths["relMd"], "meta": paths["relJson"]}


def load_analysis_for(abs_paths: list[str], mode: str = "directory", target: str | None = None) -> dict | None:
    """Read back a stored analysis for a workspace of one or more folders.
    Returns LoadedAnalysis {meta, markdown, body} or None."""
    return _load_analysis_by_slug(slug_for_paths(abs_paths), mode, target)


def load_analysis(abs_path: str, mode: str = "directory", target: str | None = None) -> dict | None:
    """Read back a stored analysis, or None if there isn't one."""
    return _load_analysis_by_slug(slug_for_path(abs_path), mode, target)


_FRONT_MATTER_RE = re.compile(r"\A---\r?\n[\s\S]*?\r?\n---\r?\n+")


def _load_analysis_by_slug(slug: str, mode: str, target: str | None) -> dict | None:
    paths = artifact_paths({"slug": slug, "mode": mode, "target": target})
    if not os.path.exists(paths["md"]) or not os.path.exists(paths["json"]):
        return None
    try:
        with open(paths["json"], encoding="utf-8") as f:
            meta = json.load(f)
        with open(paths["md"], encoding="utf-8", newline="") as f:
            markdown = f.read()
        body = _FRONT_MATTER_RE.sub("", markdown, count=1)
        return {"meta": meta, "markdown": markdown, "body": body}
    except (OSError, ValueError):
        return None


def list_analyses() -> list[dict]:
    """Everything in the store."""
    return _read_index()["workspaces"]


def index_entry_for(abs_paths: list[str] | str) -> dict | None:
    """The index entry for one path (or folder list), or None."""
    slug = slug_for_paths(abs_paths) if isinstance(abs_paths, list) else slug_for_path(abs_paths)
    return next((w for w in _read_index()["workspaces"] if w.get("slug") == slug), None)


def is_stale(meta: dict, current: dict) -> bool:
    """True when a stored analysis is older than the newest mtime among the files it
    covered, or the set of files has changed — i.e. don't trust this report.

    Files are keyed by folder + name, because two folders in one workspace can
    each contain an `index.html`.
    """
    generated = parse_iso_ms(meta.get("finishedAt"))
    if generated is None:
        return True
    for f in current.get("files", []):
        m = parse_iso_ms(f.get("mtime"))
        if m is not None and m > generated:
            return True

    def key(folder: Any, name: str) -> str:
        return f"{(folder or '').lower()}|{name}"

    before = {key(f.get("folder"), f.get("name")) for f in meta.get("filesAnalyzed") or []}
    return any(key(f.get("folder"), f.get("name")) not in before for f in current.get("files", []))


__all__ = [
    "ANALYSIS_DIR", "INDEX_PATH", "WORKSPACE_ENV_KEY", "MAX_PATHS", "MAX_FILE_BYTES",
    "SECRET_RE", "SKIP_DIRS", "WRITABLE_IMAGE_EXT",
    "WorkspacePathError", "WorkspaceWriteError",
    "iso_now", "iso_from_timestamp", "parse_iso_ms", "now_ms", "js_parse_int", "js_round1", "js_round",
    "locale_key", "js_extname",
    "get_workspace_paths", "get_workspace_path", "set_workspace_paths", "file_cap",
    "validate_workspace_path", "is_text_file", "enumerate_workspace", "enumerate_workspaces",
    "slug_for_path", "slug_for_paths", "slug_for_file", "artifact_paths",
    "sniff_image_type", "safe_asset_name", "save_asset_to_workspace", "write_atomic",
    "save_analysis", "load_analysis_for", "load_analysis", "list_analyses", "index_entry_for", "is_stale",
]
