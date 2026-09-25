"""Read-only client for the team's skills in Azure DevOps Git.

The Custom Team keeps its reusable procedures as skills: one folder per skill
under /Skills in the Custom-Team repo (renweb / Custom Development by
default), each with a SKILL.md whose YAML front matter names the skill and
says when to use it. The fix planner is handed an inventory of every skill
plus the full text of the few that match the case, so the plan follows how
the team actually does that kind of work.

AUTH and FAILURE: exactly as ado_wiki — the same `az login` token, and every
failure is a SkillsUnavailable (a WikiUnavailable subclass) that callers turn
into a warning. A plan without skills is still a plan.

CACHE: `.analysis/skills/` (git-ignored), 24h, like the wiki.

Shapes (plain dicts):
  SkillInfo {name, folder, skillMdPath, files: [relpaths], url}
  Skill     SkillInfo + {description, content}
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import math
import re
from pathlib import Path
from typing import Any

from . import ado_wiki
from .ado_wiki import WikiUnavailable, _enc
from .case_keywords import count_term_hits, normalize_text
from .env import read_env_file
from .wiki_select import idf
from .workspace import ANALYSIS_DIR, is_text_file, iso_now, js_parse_int, locale_key, now_ms, parse_iso_ms, write_atomic

SKILLS_DIR = Path(ANALYSIS_DIR) / "skills"
TREE_PATH = SKILLS_DIR / "tree.json"
PAGES_DIR = SKILLS_DIR / "pages"

CACHE_MS = 24 * 3_600_000
LABEL = "team skills repo"

# Prompt budget: full SKILL.md text per skill and in total, and the inventory
# description per row.
MAX_SKILL_CHARS = 8_000
MAX_SKILLS_CHARS = 24_000
MAX_DESC_CHARS = 600
MAX_FILES_LISTED = 15
# A full-text skill's own files (skeletons, references) that go with it.
MAX_ASSET_CHARS = 20_000
MAX_ASSETS_CHARS = 40_000


class SkillsUnavailable(WikiUnavailable):
    pass


def skills_config() -> dict:
    """{org, project, repo, path, branch, enabled, maxFull} — read live from .env.
    Org and project default to the wiki's, since both live in the same project."""
    env = read_env_file()
    wiki = ado_wiki.wiki_config()
    n = js_parse_int((env.get("CREATIO_SKILLS_MAX_FULL") or "").strip())
    path = (env.get("ADO_SKILLS_PATH") or "/Skills").strip().replace("\\", "/")
    if not path.startswith("/"):
        path = "/" + path
    return {
        "org": (env.get("ADO_SKILLS_ORG") or wiki["org"]).strip(),
        "project": (env.get("ADO_SKILLS_PROJECT") or wiki["project"]).strip(),
        "repo": (env.get("ADO_SKILLS_REPO") or "Custom-Team").strip(),
        "path": path.rstrip("/") or "/",
        "branch": (env.get("ADO_SKILLS_BRANCH") or "").strip(),
        "enabled": not re.fullmatch(r"(0|false|no|off)", (env.get("CREATIO_SKILLS_ENABLED") or "").strip(), re.IGNORECASE),
        "maxFull": 4 if n is None else max(1, min(10, n)),
    }


def _items_base(c: dict) -> str:
    return f"https://dev.azure.com/{_enc(c['org'])}/{_enc(c['project'])}/_apis/git/repositories/{_enc(c['repo'])}/items"


def _version_qs(c: dict) -> str:
    if not c["branch"]:
        return ""
    return f"&versionDescriptor.version={_enc(c['branch'])}&versionDescriptor.versionType=branch"


def file_url(c: dict, path: str) -> str:
    """Browser link for a file or folder in the repo."""
    base = f"https://dev.azure.com/{_enc(c['org'])}/{_enc(c['project'])}/_git/{_enc(c['repo'])}?path={_enc(path)}"
    return base + (f"&version=GB{_enc(c['branch'])}" if c["branch"] else "")


def _key(c: dict) -> str:
    return f"{c['org']}/{c['project']}/{c['repo']}@{c['branch'] or '(default)'}:{c['path']}"


def _rewrap(e: WikiUnavailable) -> SkillsUnavailable:
    """ado_wiki's token errors say "team wiki"; say what was actually skipped."""
    if e.reason == "az-missing":
        return SkillsUnavailable(
            "The Azure CLI (az) isn't installed, so the team skills were skipped. Install it and run `az login`.",
            e.reason,
        )
    if e.reason == "not-logged-in" and "team wiki" in str(e):
        return SkillsUnavailable(
            "The Azure CLI isn't logged in (or the login expired), so the team skills were skipped. Run `az login`.",
            e.reason,
        )
    return e if isinstance(e, SkillsUnavailable) else SkillsUnavailable(str(e), e.reason)


async def _get(url: str) -> dict:
    try:
        return await ado_wiki._ado_get(url, LABEL)
    except WikiUnavailable as e:
        raise _rewrap(e) from None


def _require_enabled(c: dict) -> None:
    if not c["enabled"]:
        raise SkillsUnavailable("Team skills lookup is turned off (CREATIO_SKILLS_ENABLED).", "disabled")


def _fresh(iso: Any) -> bool:
    t = parse_iso_ms(iso or "")
    return t is not None and now_ms() - t < CACHE_MS


def _dump(obj: Any) -> str:
    return json.dumps(obj, indent=2, ensure_ascii=False)


# ---------------------------------------------------------------------------
# Tree
# ---------------------------------------------------------------------------


def group_skills(items: Any, root: str, c: dict) -> list[dict]:
    """Group a recursive Items listing into one SkillInfo per first-level folder
    that holds a SKILL.md. Exported for tests."""
    rows = items.get("value") if isinstance(items, dict) else items
    prefix = root.rstrip("/") + "/"
    by_folder: dict[str, dict] = {}
    for it in rows if isinstance(rows, list) else []:
        if not isinstance(it, dict) or not isinstance(it.get("path"), str):
            continue
        path = it["path"]
        if not path.lower().startswith(prefix.lower()) or it.get("isFolder"):
            continue
        rel = path[len(prefix):]
        if "/" not in rel:
            continue  # a loose file directly under /Skills, not a skill
        folder, inner = rel.split("/", 1)
        if folder.startswith("."):
            continue
        s = by_folder.setdefault(folder, {"folder": folder, "skillMdPath": None, "files": []})
        if inner.lower() == "skill.md":
            s["skillMdPath"] = path
        else:
            s["files"].append(inner)
    out = []
    for folder, s in by_folder.items():
        if not s["skillMdPath"]:
            continue
        out.append({
            "name": folder,
            "folder": folder,
            "skillMdPath": s["skillMdPath"],
            "files": sorted(s["files"], key=locale_key),
            "url": file_url(c, s["skillMdPath"]),
        })
    out.sort(key=lambda s: locale_key(s["name"]))
    return out


async def list_skills(refresh: bool = False) -> list[dict]:
    c = skills_config()
    _require_enabled(c)
    key = _key(c)
    if not refresh:
        try:
            with open(TREE_PATH, encoding="utf-8") as f:
                doc = json.load(f)
            if doc.get("repo") == key and _fresh(doc.get("fetchedAt")) and isinstance(doc.get("skills"), list):
                return doc["skills"]
        except (OSError, ValueError, AttributeError):
            pass  # no cache yet
    got = await _get(
        f"{_items_base(c)}?scopePath={_enc(c['path'])}&recursionLevel=Full{_version_qs(c)}&api-version=7.1"
    )
    skills = group_skills(got["json"], c["path"], c)
    write_atomic(TREE_PATH, _dump({"fetchedAt": iso_now(), "repo": key, "skills": skills}))
    return skills


# ---------------------------------------------------------------------------
# SKILL.md
# ---------------------------------------------------------------------------


def parse_front_matter(md: str) -> dict:
    """{name?, description?, body} from a SKILL.md. A deliberately small parser:
    `key: value` lines, quoted values, and `>`/`|` block scalars — which is all
    skill front matter uses. Exported for tests."""
    text = str(md or "").lstrip("﻿")
    m = re.match(r"---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|\Z)", text)
    if not m:
        return {"body": text}
    lines = m.group(1).splitlines()
    out: dict = {"body": text[m.end():]}
    i = 0
    while i < len(lines):
        km = re.match(r"([A-Za-z_][\w-]*)\s*:\s*(.*)\Z", lines[i])
        i += 1
        if not km:
            continue
        key, val = km.group(1), km.group(2).strip()
        if val in (">", "|", ">-", "|-", ">+", "|+"):
            block = []
            while i < len(lines) and (not lines[i].strip() or lines[i][:1] in (" ", "\t")):
                block.append(lines[i].strip())
                i += 1
            val = ("\n" if val.startswith("|") else " ").join(block).strip()
        elif len(val) >= 2 and val[0] == val[-1] and val[0] in "'\"":
            val = val[1:-1]
        if key in ("name", "description"):
            out[key] = val
    return out


def _page_cache_path(key: str) -> Path:
    return Path(PAGES_DIR) / (hashlib.sha1(key.encode("utf-8")).hexdigest()[:16] + ".json")


async def get_skill(info: dict, refresh: bool = False) -> dict:
    """Fetch one skill's SKILL.md → Skill. `info` is a SkillInfo from list_skills."""
    c = skills_config()
    _require_enabled(c)
    key = f"{_key(c)}|{info['skillMdPath']}"
    file = _page_cache_path(key)
    if not refresh:
        try:
            with open(file, encoding="utf-8") as f:
                doc = json.load(f)
            if doc.get("key") == key and _fresh(doc.get("fetchedAt")):
                return {**info, **doc["skill"]}
        except (OSError, ValueError, AttributeError, KeyError):
            pass  # not cached
    got = await _get(
        f"{_items_base(c)}?path={_enc(info['skillMdPath'])}&includeContent=true&%24format=json{_version_qs(c)}&api-version=7.1"
    )
    j = got["json"] if isinstance(got["json"], dict) else {}
    content = j.get("content") if isinstance(j.get("content"), str) else ""
    fm = parse_front_matter(content)
    skill = {
        "name": (fm.get("name") or info["name"]).strip() or info["name"],
        "description": (fm.get("description") or "").strip(),
        "content": content.strip(),
    }
    write_atomic(file, _dump({"key": key, "fetchedAt": iso_now(), "skill": skill}))
    return {**info, **skill}


async def get_skill_file(info: dict, relpath: str, refresh: bool = False) -> str:
    """One file of a skill (a skeleton, a reference doc) as text. `relpath` must
    be one of the skill's listed files, so only the repo's own paths are read."""
    if relpath not in (info.get("files") or []):
        raise SkillsUnavailable(f'"{relpath}" is not a file of the {info.get("name")} skill.', "http")
    c = skills_config()
    _require_enabled(c)
    path = info["skillMdPath"].rsplit("/", 1)[0] + "/" + relpath
    key = f"{_key(c)}|{path}"
    file = _page_cache_path(key)
    if not refresh:
        try:
            with open(file, encoding="utf-8") as f:
                doc = json.load(f)
            if doc.get("key") == key and _fresh(doc.get("fetchedAt")):
                return doc["content"]
        except (OSError, ValueError, AttributeError, KeyError):
            pass  # not cached
    got = await _get(
        f"{_items_base(c)}?path={_enc(path)}&includeContent=true&%24format=json{_version_qs(c)}&api-version=7.1"
    )
    j = got["json"] if isinstance(got["json"], dict) else {}
    content = j.get("content") if isinstance(j.get("content"), str) else ""
    write_atomic(file, _dump({"key": key, "fetchedAt": iso_now(), "content": content}))
    return content


async def attach_skill_assets(skills: list[dict]) -> list[dict]:
    """Give each skill whose full text goes to the planner its text files too —
    the skeletons and references its instructions point at — within budget:
    MAX_ASSET_CHARS per file, MAX_ASSETS_CHARS in total, `assets/` first.
    A file that can't be read is left out."""
    left = MAX_ASSETS_CHARS
    for s in skills:
        if not s.get("full"):
            continue
        names = [f for f in s.get("files") or [] if is_text_file(f.rsplit("/", 1)[-1])]
        names.sort(key=lambda f: (not f.lower().startswith("assets/"), locale_key(f)))
        assets = []
        for f in names:
            if left <= 500:
                break
            try:
                text = await get_skill_file(s, f)
            except WikiUnavailable:
                continue
            if not text.strip():
                continue
            n = min(MAX_ASSET_CHARS, left)
            if len(text) > n:
                text = text[:n] + "\n… [file clipped]"
            left -= len(text)
            assets.append({"path": f, "content": text})
        s["assets"] = assets
    return skills


async def get_skill_by_name(name: str, refresh: bool = False) -> dict | None:
    for s in await list_skills(refresh=refresh):
        if s["name"].lower() == name.lower() or s["folder"].lower() == name.lower():
            return await get_skill(s, refresh=refresh)
    return None


async def load_all_skills(refresh: bool = False) -> list[dict]:
    """Every skill with its SKILL.md. A skill whose file can't be fetched keeps
    its folder name and an empty body rather than failing the whole list."""
    infos = await list_skills(refresh=refresh)

    async def one(i: dict) -> dict:
        try:
            return await get_skill(i, refresh=refresh)
        except WikiUnavailable:
            return {**i, "description": "", "content": ""}

    return list(await asyncio.gather(*(one(i) for i in infos)))


# ---------------------------------------------------------------------------
# Selection
# ---------------------------------------------------------------------------


def score_skills(skills: list[dict], terms: list[dict]) -> list[dict]:
    """Score each skill against the case terms: name hits count most, then the
    description (which is written as a when-to-use trigger), then the body with
    diminishing returns. IDF-weighted across the skills, as wiki_select does,
    so a term every skill mentions picks nothing out. Exported for tests."""
    docs = [
        {
            "s": s,
            "name": normalize_text(re.sub(r"[-_]", " ", s.get("name") or "")),
            "desc": normalize_text(re.sub(r"[-_]", " ", s.get("description") or "")),
            "body": normalize_text(re.sub(r"[-_]", " ", s.get("content") or "")),
        }
        for s in skills
    ]
    n = len(docs)
    factor = {
        t["term"]: idf(sum(1 for d in docs if count_term_hits(d["name"] + " " + d["desc"], t["term"])), n) for t in terms
    }
    out = []
    for d in docs:
        score = 0.0
        matched: list[str] = []
        for t in terms:
            f = factor.get(t["term"], 1)
            add = 0.0
            if count_term_hits(d["name"], t["term"]):
                add += 2.0
            if count_term_hits(d["desc"], t["term"]):
                add += 1.5
            hits = count_term_hits(d["body"], t["term"])
            if hits:
                add += 0.5 * min(3, math.log2(1 + hits))
            if add:
                score += t["weight"] * add * f
                matched.append(t["term"])
        why = f"matches {', '.join(matched[:4])}" if matched else ""
        out.append({**d["s"], "score": round(score, 1), "why": why})
    out.sort(key=lambda s: (-s["score"], locale_key(s["name"])))
    return out


def select_skills(skills: list[dict], terms: list[dict], max_full: int) -> list[dict]:
    """→ every skill, ranked, each with `full: bool`. Only the top `max_full`
    that match the case at all get their full SKILL.md in the prompt, clipped to
    the budget; the rest appear in the inventory by name and description, so
    the planner can still name a skill the scoring missed."""
    ranked = score_skills(skills, terms)
    left = MAX_SKILLS_CHARS
    chosen = 0
    out = []
    for s in ranked:
        full = False
        content = s.get("content") or ""
        if chosen < max_full and s["score"] > 0 and content and left > 500:
            n = min(MAX_SKILL_CHARS, left)
            if len(content) > n:
                content = content[:n] + "\n… [skill clipped]"
            left -= len(content)
            chosen += 1
            full = True
        out.append({**s, "content": content if full else "", "full": full})
    return out


def skills_summary(skills: list[dict]) -> list[dict]:
    """Without bodies — what the SSE `start` event and the plan store carry."""
    return [{k: s[k] for k in ("name", "url", "full", "score", "why") if k in s} for s in skills]


async def test_skills() -> dict:
    """Settings-tab probe → {ok, skills?, message, reason?}"""
    try:
        skills = await list_skills(refresh=True)
        c = skills_config()
        return {
            "ok": True,
            "skills": len(skills),
            "message": f"Connected to {c['repo']}{c['path']} — {len(skills)} skills.",
        }
    except WikiUnavailable as e:
        return {"ok": False, "message": str(e), "reason": e.reason}
    except Exception as e:  # noqa: BLE001 — surfaced to the UI verbatim
        return {"ok": False, "message": str(e), "reason": "http"}


test_skills.__test__ = False  # type: ignore[attr-defined]
