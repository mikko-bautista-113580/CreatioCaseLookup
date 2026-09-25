"""Work out a case's scope: its keywords and the related workspace files.
Deterministic and model-free — this is the fast step that decides what the
case-scoped analysis reads.

Shared by the web server (preview + analyze) and workspace_cli (`scope`), so
the app and the skills always agree on what "related to this case" means.

CaseScope (dict, camelCase as in TS): caseNumber, terms, files, searched,
searchTruncated, cap, durationMs.
"""

from __future__ import annotations

from typing import Any

from .case_files import enumerate_deep, rank_case_files
from .case_keywords import extract_case_terms
from .workspace import file_cap, now_ms


async def compute_case_scope(brief: dict[str, Any], paths: list[str]) -> dict:
    started = now_ms()
    terms = extract_case_terms(brief)
    cap = file_cap()
    # Walk folders named after the case's school codes first.
    deep = enumerate_deep(paths, prefer=[t["term"] for t in terms if t["kind"] == "code"])
    files = rank_case_files(deep["files"], terms, cap)
    return {
        "caseNumber": brief.get("number"),
        "terms": terms,
        "files": files,
        "searched": len(deep["files"]),
        "searchTruncated": deep["truncated"],
        "cap": cap,
        "durationMs": now_ms() - started,
    }
