"""Find the workspace files related to one case — quickly, and without a model.

The whole-folder analysis reads every top-level file whatever the case is.
A case-scoped analysis instead reads only what this module ranks as related:

  1. walk the folders RECURSIVELY (school-code folders sit under the root),
     bounded by depth, file count and a time budget;
  2. score each file by its path (a school-code folder or a file named in the
     case is the strongest signal there is) and by how often its content
     mentions the case terms;
  3. follow ONE hop of `<cfinclude template>` / `<cfmodule template>` from
     the best hits, because a report template's bug often lives in the
     include it pulls in;
  4. keep the top `file_cap()`.

Every file carries a `rel` path produced by this walk (always forward-slash).
Nothing downstream ever joins a model- or user-supplied string onto a folder:
edits are matched against this census by (folder, rel), exactly as the
top-level census works.

Shapes (dicts): DeepFile ``{rel, folder, size, mtime, ext}``; RankedFile is a
DeepFile plus ``score`` and ``reason``; DeepEnum ``{files, truncated}``.
"""

from __future__ import annotations

import math
import os
import posixpath
import re
import stat
import time
from collections import deque
from typing import Callable

from .case_keywords import count_term_hits
from .wiki_select import idf
from .workspace import (
    MAX_FILE_BYTES,
    SECRET_RE,
    SKIP_DIRS,
    _entry_is_dir,
    _entry_is_file,
    _mtime_iso,
    _mtime_ms,
    _scandir,
    is_text_file,
    js_extname,
    js_round1,
    locale_key,
    parse_iso_ms,
)

MAX_DEPTH = 5
MAX_FILES = 5000
WALK_BUDGET_MS = 3000
READ_BUDGET_MS = 3000
READ_BUDGET_BYTES = 60 * 1024 * 1024
# How many top hits have their includes followed.
INCLUDE_SOURCES = 5
# Drop files scoring under this fraction of the best match.
RELATIVE_FLOOR = 0.25


def _ms() -> float:
    return time.monotonic() * 1000


def enumerate_deep(
    dirs: list[str],
    *,
    max_depth: int | None = None,
    max_files: int | None = None,
    budget_ms: int | None = None,
    prefer: list[str] | None = None,
) -> dict:
    """Recursive, bounded census of the text/source files under each folder.

    `prefer`: directory names (lowercase) to walk FIRST — a case's school codes.
    A reports root can hold thousands of school folders; without this, the file
    limit is spent on folders alphabetically before the right one.

    Returns ``{files: [DeepFile], truncated}`` — truncated means the walk stopped
    early (depth, count or time) and the view is partial.
    """
    max_depth = MAX_DEPTH if max_depth is None else max_depth
    max_files = MAX_FILES if max_files is None else max_files
    deadline = _ms() + (WALK_BUDGET_MS if budget_ms is None else budget_ms)
    files: list[dict] = []
    truncated = False
    prefer_set = {p.lower() for p in (prefer or [])}

    for root in dirs:
        queue: deque[tuple[str, str, int]] = deque([(root, "", 0)])
        while queue:
            if len(files) >= max_files or _ms() > deadline:
                truncated = True
                break
            abs_dir, rel, depth = queue.popleft()
            try:
                entries = _scandir(abs_dir)
            except OSError:
                continue
            for e in entries:
                name = e.name
                child_rel = f"{rel}/{name}" if rel else name
                if _entry_is_dir(e):
                    if name.lower() in SKIP_DIRS or name.startswith("."):
                        continue
                    if depth + 1 > max_depth:
                        truncated = True
                        continue
                    nxt = (os.path.join(abs_dir, name), child_rel, depth + 1)
                    if name.lower() in prefer_set:
                        queue.appendleft(nxt)
                    else:
                        queue.append(nxt)
                    continue
                if not _entry_is_file(e):
                    continue
                if SECRET_RE.search(name) or not is_text_file(name):
                    continue
                try:
                    st = os.stat(os.path.join(abs_dir, name))
                except OSError:
                    continue
                if st.st_size > MAX_FILE_BYTES:
                    continue
                files.append({
                    "rel": child_rel,
                    "folder": root,
                    "size": st.st_size,
                    "mtime": _mtime_iso(st),
                    "ext": js_extname(name).lower(),
                })
                if len(files) >= max_files:
                    truncated = True
                    break
    return {"files": files, "truncated": truncated}


def _count_hits(hay: str, term: str) -> int:
    return count_term_hits(hay, term)


def _path_match(path_lower: str, compact: str, term: str) -> bool:
    """Does the term appear in the path, either word-bounded or squashed together ("reportcard")?"""
    if _count_hits(path_lower, term):
        return True
    tc = re.sub(r"[^a-z0-9]", "", term)
    return len(tc) >= 4 and tc in compact


_INCLUDE_RE = re.compile(
    r"<cf(?:include|module)\b[^>]*\btemplate\s*=\s*[\"']([^\"']+)[\"']", re.IGNORECASE | re.ASCII
)


def include_targets(content: str) -> list[str]:
    """`<cfinclude template="…">` and `<cfmodule template="…">` targets. Exported for tests."""
    out: list[str] = []
    for m in _INCLUDE_RE.finditer(content):
        t = m.group(1).strip()
        # A dynamic path (#var#) can't be resolved statically.
        if t and "#" not in t:
            out.append(t)
    return out


def _read_from_disk(f: dict) -> str:
    with open(os.path.join(f["folder"], *f["rel"].split("/")), encoding="utf-8", errors="replace", newline="") as fh:
        return fh.read()


def _posix_normalize(p: str) -> str:
    """``path.posix.normalize`` — like normpath but keeps a trailing slash."""
    n = posixpath.normpath(p) if p else "."
    if p.endswith("/") and not n.endswith("/"):
        n += "/"
    return n


def rank_case_files(
    deep: list[dict],
    terms: list[dict],
    cap: int,
    read_file: Callable[[dict], str] = _read_from_disk,
) -> list[dict]:
    """Rank the census against the case terms and keep the top `cap`.
    `read_file` is a test seam; it defaults to reading from disk."""
    if not terms or not deep:
        return []

    # Pass 1 — path matches, recorded per term so they can be weighted by how
    # distinctive each term turns out to be across the whole census.
    scored = []
    for f in deep:
        path_lower = f["rel"].lower()
        compact = re.sub(r"[^a-z0-9]", "", path_lower)
        segs = path_lower.split("/")
        path_hits = []
        for t in terms:
            if not _path_match(path_lower, compact, t["term"]):
                continue
            # A school code naming the FOLDER is the strongest pointer we have.
            folder_hit = t["kind"] == "code" and any(s == t["term"] for s in segs[:-1])
            file_hit = t["kind"] == "file" and posixpath.basename(path_lower) == t["term"]
            if file_hit:
                label = "named in the case"
            elif folder_hit:
                label = f"in the {t['term'].upper()} folder"
            else:
                label = f'path matches "{t["term"]}"'
            path_hits.append({"t": t, "boost": 3 if folder_hit or file_hit else 1, "label": label})
        scored.append({"f": f, "pathHits": path_hits, "contentHits": [], "read": False})

    # Pass 2 — content. Read the most promising files first, so running out of
    # budget drops the least likely ones.
    def path_sum(s: dict) -> float:
        total = 0
        for h in s["pathHits"]:
            total += h["t"]["weight"] * h["boost"]
        return total

    order = sorted(scored, key=lambda s: -path_sum(s))
    deadline = _ms() + READ_BUDGET_MS
    nbytes = 0
    for s in order:
        if _ms() > deadline or nbytes > READ_BUDGET_BYTES:
            break
        try:
            text = read_file(s["f"])
        except Exception:
            continue
        s["read"] = True
        nbytes += len(text)
        hay = text.lower()
        for t in terms:
            n = _count_hits(hay, t["term"])
            if n:
                s["contentHits"].append({"t": t, "n": n})

    # Document frequencies → how distinctive each term is.
    n_all = len(scored)
    n_read = sum(1 for s in scored if s["read"]) or 1
    path_idf = {
        t["term"]: idf(sum(1 for s in scored if any(h["t"] is t for h in s["pathHits"])), n_all) for t in terms
    }
    content_idf = {
        t["term"]: idf(sum(1 for s in scored if any(h["t"] is t for h in s["contentHits"])), n_read) for t in terms
    }

    ranked = []
    for s in scored:
        score = 0.0
        why: list[str] = []
        for h in s["pathHits"]:
            score += 2 * h["t"]["weight"] * h["boost"] * path_idf.get(h["t"]["term"], 1)
            why.append(h["label"])
        mentioned: list[str] = []
        for h in s["contentHits"]:
            score += h["t"]["weight"] * min(3, math.log2(1 + h["n"])) * content_idf.get(h["t"]["term"], 1)
            mentioned.append(f'"{h["t"]["term"]}"×{h["n"]}' if h["n"] > 1 else f'"{h["t"]["term"]}"')
        if mentioned:
            why.append(f"mentions {', '.join(mentioned[:3])}")
        ranked.append({**s["f"], "why": why, "score": js_round1(score)})
    ranked = [r for r in ranked if r["score"] > 0]
    ranked.sort(key=lambda r: (-r["score"], locale_key(r["rel"])))

    # One include hop from the best hits.
    by_key = {f"{f['folder'].lower()}|{f['rel'].lower()}": f for f in deep}
    extra: dict[str, dict] = {}
    for src in ranked[:INCLUDE_SOURCES]:
        try:
            text = read_file(src)
        except Exception:
            continue
        d = posixpath.dirname(src["rel"]) or "."
        for t in include_targets(text):
            norm = t.replace("\\", "/")
            if norm.startswith("/"):
                rel = re.sub(r"^/+", "", norm)
            else:
                rel = _posix_normalize(posixpath.join("" if d == "." else d, norm))
            if rel.startswith(".."):
                continue
            hit = by_key.get(f"{src['folder'].lower()}|{rel.lower()}")
            if not hit:
                continue
            key = f"{hit['folder']}|{hit['rel']}"
            if any(f"{r['folder']}|{r['rel']}" == key and r["score"] >= src["score"] * 0.5 for r in ranked):
                continue
            if key not in extra:
                extra[key] = {
                    **hit,
                    "score": _half(src["score"]),
                    "reason": f"included by {src['rel']}",
                }

    merged: dict[str, dict] = {}
    for r in ranked:
        merged[f"{r['folder']}|{r['rel']}"] = {
            "rel": r["rel"], "folder": r["folder"], "size": r["size"], "mtime": r["mtime"], "ext": r["ext"],
            "score": r["score"],
            "reason": " · ".join(r["why"]) or "matched the case terms",
        }
    for k, e in extra.items():
        cur = merged.get(k)
        if not cur or cur["score"] < e["score"]:
            merged[k] = {**cur, "score": e["score"], "reason": f"{cur['reason']} · {e['reason']}"} if cur else e
    out = sorted(merged.values(), key=lambda r: (-r["score"], locale_key(r["rel"])))
    # Fewer, right files beat a full list: once the school's own folder has
    # been found, another school's report card is noise that costs read time.
    floor = (out[0]["score"] if out else 0) * RELATIVE_FLOOR
    return [f for f in out if f["score"] >= floor][:cap]


def _half(score: float) -> float | int:
    """``Math.round(score * 5) / 10`` — half the score, to one decimal."""
    r = math.floor(score * 5 + 0.5) / 10
    return int(r) if r == int(r) else r


def to_selection(ranked: list[dict]) -> list[dict]:
    """Selection rows as stored in the analysis sidecar."""
    return [{"rel": r["rel"], "folder": r["folder"], "score": r["score"], "reason": r["reason"]} for r in ranked]


def _revalidate(sel: dict, paths: list[str]) -> dict | None:
    """Re-validate one stored selection row against the disk.

    The rows come from our own sidecar, but a sidecar is a file on disk and the
    folder may have changed since — so everything the walk checked is checked
    again, and a row that fails is simply dropped.
    """
    folder = next((p for p in paths if p.lower() == str(sel.get("folder") or "").lower()), None)
    if not folder:
        return None
    rel = str(sel.get("rel") or "").replace("\\", "/")
    if (
        not rel
        or rel.startswith("/")
        or os.path.isabs(rel)
        or re.match(r"[a-z]:", rel, re.IGNORECASE)
        or any(s in ("..", "", ".") for s in rel.split("/"))
    ):
        return None
    name = rel.split("/")[-1]
    if SECRET_RE.search(name) or not is_text_file(name):
        return None
    if any(s.lower() in SKIP_DIRS or s.startswith(".") for s in rel.split("/")[:-1]):
        return None
    try:
        st = os.stat(os.path.join(folder, *rel.split("/")))
    except OSError:
        return None
    if not stat.S_ISREG(st.st_mode) or st.st_size > MAX_FILE_BYTES:
        return None
    return {"name": rel, "folder": folder, "size": st.st_size, "mtime": _mtime_iso(st), "ext": js_extname(name).lower()}


def with_case_files(en: dict, selection: list[dict] | None, paths: list[str]) -> dict:
    """The census a case fix may edit: the top-level files plus the case's selected
    files in subfolders (named by their `rel` path). Returns a new result; the
    input is not mutated."""
    if not selection:
        return en
    folders = [{**f, "files": list(f["files"])} for f in en["folders"]]
    files = list(en["files"])
    have = {f"{str(f.get('folder')).lower()}|{f['name']}" for f in files}
    for sel in selection:
        hit = _revalidate(sel, paths)
        if not hit:
            continue
        key = f"{hit['folder'].lower()}|{hit['name']}"
        if key in have:
            continue
        have.add(key)
        files.append(hit)
        plain = {k: v for k, v in hit.items() if k != "folder"}
        target = next((f for f in folders if f["path"].lower() == hit["folder"].lower()), None)
        if target is not None:
            target["files"].append(plain)
    return {**en, "folders": folders, "files": files, "count": len(files)}


def is_case_analysis_stale(meta: dict, brief_fetched_at: str | None = None) -> bool:
    """A case analysis is stale when a selected file changed after it was written,
    a selected file is gone, or the case brief was re-fetched since."""
    generated = parse_iso_ms(meta.get("finishedAt"))
    if generated is None:
        return True
    if brief_fetched_at and meta.get("briefFetchedAt") and brief_fetched_at != meta.get("briefFetchedAt"):
        return True
    for s in meta.get("selection") or []:
        try:
            st = os.stat(os.path.join(s["folder"], *str(s["rel"]).split("/")))
        except (OSError, KeyError, TypeError):
            return True
        if _mtime_ms(st) > generated:
            return True
    return False
