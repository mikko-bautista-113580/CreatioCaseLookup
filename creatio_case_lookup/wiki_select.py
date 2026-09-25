"""Pick the team-wiki pages that match a case.

Two stages, both deterministic:
  1. score every page PATH against the case terms (titles are short and the
     team names pages well, so this alone usually finds the right section);
  2. fetch the best ~12 and re-score on their CONTENT, which separates, say,
     "Custom Report Card Workflow" from "Report Card Testing Email".

Only pages scoring above MIN_SCORE are kept — returning nothing is better
than handing the analysis an irrelevant page to anchor on.

Pages are dicts: WikiPageInfo ``{path, id?, section}``, WikiPage
``{path, id?, url, content}``, ScoredPage ``{path, id?, score, why}``.
"""

from __future__ import annotations

import asyncio
import math
import re
from typing import Awaitable, Callable

from .case_keywords import count_term_hits, normalize_text
from .workspace import js_round1, locale_key

STAGE2_CANDIDATES = 12
MIN_SCORE = 4
# How much of a page goes into a prompt.
MAX_PAGE_CHARS = 6_000
MAX_WIKI_CHARS = 20_000


def _hits(hay: str, term: str) -> int:
    return count_term_hits(hay, term)


def idf(df: int, n: int) -> float:
    """How distinctive a term is across a collection: ~1 when it appears almost
    nowhere, falling towards 0 as it appears everywhere. "report" in a wiki full
    of report pages, or in a folder full of report cards, picks nothing out."""
    if n <= 1:
        return 1
    return math.log(1 + n / (1 + df)) / math.log(1 + n)


def _with_id(d: dict, page_id) -> dict:
    """Insert `id` after `path`, omitted when undefined (as JSON.stringify would)."""
    out = {"path": d["path"]}
    if page_id is not None:
        out["id"] = page_id
    out.update({k: v for k, v in d.items() if k != "path"})
    return out


def score_by_path(pages: list[dict], terms: list[dict]) -> list[dict]:
    """Stage 1: score by path. Exported for tests."""
    parsed = []
    for p in pages:
        segs = [s for s in p["path"].split("/") if s]
        parsed.append({
            "p": p,
            "title": normalize_text(re.sub(r"[-_]", " ", segs[-1] if segs else "")),
            "parents": normalize_text(re.sub(r"[-_]", " ", " ".join(segs[:-1]))),
        })
    factor = {
        t["term"]: idf(sum(1 for x in parsed if _hits(x["title"], t["term"])), len(parsed)) for t in terms
    }
    out = []
    for x in parsed:
        p = x["p"]
        score = 0.0
        matched: list[str] = []
        for t in terms:
            in_title = _hits(x["title"], t["term"])
            in_parent = _hits(x["parents"], t["term"])
            if in_title or in_parent:
                score += t["weight"] * (1 if in_title else 0.4) * factor.get(t["term"], 1)
                matched.append(t["term"])
        # A leaf is a page about one thing; a section root is a table of contents.
        if p.get("section"):
            score *= 0.6
        why = f"title matches {', '.join(matched[:4])}" if matched else ""
        out.append(_with_id({"path": p["path"], "score": score, "why": why}, p.get("id")))
    out = [p for p in out if p["score"] > 0]
    out.sort(key=lambda p: (-p["score"], locale_key(p["path"])))
    return out


def rescore_by_content(candidates: list[dict], contents: dict[str, str], terms: list[dict]) -> list[dict]:
    """Stage 2: add content hits. Exported for tests."""
    out = []
    for c in candidates:
        body = normalize_text(re.sub(r"[-_]", " ", contents.get(c["path"]) or ""))
        add = 0.0
        matched: list[str] = []
        for t in terms:
            n = _hits(body, t["term"])
            if n:
                # Diminishing returns: a page that says "gpa" 40 times isn't 40x better.
                add += t["weight"] * min(3, math.log2(1 + n))
                matched.append(t["term"])
        # An empty page (a pure folder) can't teach the analysis anything.
        empty = len(body) < 40
        score = 0 if empty else c["score"] + add * 0.5
        why = "; ".join(x for x in [c["why"], f"mentions {', '.join(matched[:4])}" if matched else ""] if x)
        out.append({**c, "score": js_round1(score), "why": why})
    out = [c for c in out if c["score"] >= MIN_SCORE]
    out.sort(key=lambda c: (-c["score"], locale_key(c["path"])))
    return out


async def select_wiki_pages(
    tree: list[dict],
    terms: list[dict],
    fetch_page: Callable[[str], Awaitable[dict]],
    max_pages: int,
) -> dict:
    """Run both stages → WikiSelection ``{pages: [...], skipped?}``.

    Each selected page is the ScoredPage plus ``url`` and ``content``.
    `fetch_page` failures for individual pages are tolerated — the page is
    simply dropped.
    """
    stage1 = score_by_path(tree, terms)[:STAGE2_CANDIDATES]
    if not stage1:
        return {"pages": [], "skipped": "No wiki page title matched this case's keywords."}

    async def one(c: dict):
        try:
            return await fetch_page(c["path"])
        except Exception:
            return None

    fetched = await asyncio.gather(*(one(c) for c in stage1))
    by_path: dict[str, dict] = {}
    for p in fetched:
        if p:
            by_path[p["path"]] = p
    contents = {k: v.get("content", "") for k, v in by_path.items()}

    ranked = rescore_by_content(stage1, contents, terms)[:max_pages]
    if not ranked:
        return {"pages": [], "skipped": "No wiki page was relevant enough to this case."}
    return {
        "pages": [{**r, "url": by_path[r["path"]]["url"], "content": by_path[r["path"]]["content"]} for r in ranked],
    }


def clip_wiki_pages(pages: list[dict]) -> list[dict]:
    """Clip the chosen pages to the prompt budget: per page, then in total."""
    left = MAX_WIKI_CHARS
    out: list[dict] = []
    for p in pages:
        if left <= 500:
            break
        n = min(MAX_PAGE_CHARS, left)
        content = p["content"][:n] + "\n… [page clipped]" if len(p["content"]) > n else p["content"]
        left -= len(content)
        out.append({**p, "content": content})
    return out
