"""Work out a case's scope: its keywords, the related workspace files, and the
team-wiki pages that apply. Deterministic and model-free — this is the fast
step that decides what the case-scoped analysis reads.

Shared by the web server (preview + analyze) and workspace_cli (`scope`), so
the app and the skills always agree on what "related to this case" means.

CaseScope (dict, camelCase as in TS): caseNumber, terms, files, searched,
searchTruncated, cap, wiki ([{path, url, score, why, content}]), wikiSkipped?,
durationMs.
"""

from __future__ import annotations

from typing import Any

from .ado_wiki import WikiUnavailable, get_wiki_page, get_wiki_tree, wiki_config
from .case_files import enumerate_deep, rank_case_files
from .case_keywords import extract_case_terms, vocabulary_from_titles
from .wiki_select import select_wiki_pages
from .workspace import file_cap, now_ms


async def compute_case_scope(brief: dict[str, Any], paths: list[str], wiki: bool = True) -> dict:
    started = now_ms()

    # The wiki tree doubles as vocabulary for the keywords, so fetch it first.
    tree: list[dict] | None = None
    wiki_skipped: str | None = None
    if wiki is not False:
        try:
            tree = await get_wiki_tree()
        except WikiUnavailable as e:
            wiki_skipped = str(e)
        except Exception as e:  # noqa: BLE001 — the wiki is optional
            wiki_skipped = f"Team wiki skipped: {e}"
    else:
        wiki_skipped = "Team wiki lookup was not requested."

    terms = extract_case_terms(brief, vocabulary_from_titles([p["path"] for p in tree]) if tree is not None else [])
    cap = file_cap()
    # Walk folders named after the case's school codes first.
    deep = enumerate_deep(paths, prefer=[t["term"] for t in terms if t["kind"] == "code"])
    files = rank_case_files(deep["files"], terms, cap)

    wiki_pages: list[dict] = []
    if tree is not None:
        sel = await select_wiki_pages(tree, terms, get_wiki_page, wiki_config()["maxPages"])
        wiki_pages = [
            {"path": p["path"], "url": p["url"], "score": p["score"], "why": p["why"], "content": p["content"]}
            for p in sel["pages"]
        ]
        if not wiki_pages:
            wiki_skipped = sel.get("skipped")

    out: dict = {
        "caseNumber": brief.get("number"),
        "terms": terms,
        "files": files,
        "searched": len(deep["files"]),
        "searchTruncated": deep["truncated"],
        "cap": cap,
        "wiki": wiki_pages,
    }
    if wiki_skipped is not None:
        out["wikiSkipped"] = wiki_skipped
    out["durationMs"] = now_ms() - started
    return out


def scope_summary(s: dict) -> dict:
    """The scope without page bodies — what the preview endpoint and the CLI print."""
    wiki = []
    for p in s.get("wiki", []):
        rest = {k: v for k, v in p.items() if k != "content"}
        rest["chars"] = len(p.get("content", ""))
        wiki.append(rest)
    return {**s, "wiki": wiki}
