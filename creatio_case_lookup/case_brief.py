"""The bound Creatio case: the pointer, and the stored brief.

The Workspace tab is case-first — you pick the case, then the folders, then
hand off to the `creatio-case-fix` skill. Two pieces of durable state make
that survive a browser reload AND a fresh Claude Code session:

  .env  CREATIO_WORKSPACE_CASE    the pointer: which case is bound
  .analysis/cases/<NUMBER>.json   the brief: subject, description, timeline

The server is stateless by design (every route derives its inputs from the
request plus `.env` / `.analysis/`), so there is nowhere else for a binding
to live.

---------------------------------------------------------------------------
TRUST BOUNDARY — read this before wiring this module anywhere new.

A brief holds case text written by CLIENTS and third parties. It is prose
from outside, and it is DATA, never instructions.

`analyze_workspace.py` must NEVER import this module, and its workspace stdin
builder must never gain case text. That run gets a real cwd plus
Read/Glob/Grep over the user's folders; feeding third-party prose into it is
the one combination `claude_run.py` warns against.

The brief is consumed by (a) the Workspace tab, for display, and (b) the
`creatio-case-fix` skill running in the user's own interactive session,
behind its explicit approval gate. Both are fine. A child process with file
access is not.
---------------------------------------------------------------------------
"""

from __future__ import annotations

import json
import math
import re
import time
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

from .case_lookup import _js_trim, js_date_ms, plain_mentions
from .env import read_env_file, write_env_file
from .paths import ANALYSIS_DIR
from .workspace import iso_now, write_atomic


def _text_from_segments(segments: Sequence[Mapping[str, Any]] | None) -> str:
    """Plain text from rich segments, keeping the paragraph breaks.

    `strip()` ends with ``\\s+ -> " "``, which flattens a numbered request list
    into one unreadable line. html_to_segments() already turns ``</p>``,
    ``</div>``, ``</li>`` and ``<br>`` into newlines, so the segments are the
    better source when we have them — a case's "1) ... 2) ... 3) ..." survives
    as a list.
    """
    parts: list[str] = []
    for s in segments or []:
        if s.get("type") == "list":
            # A list becomes "- item" lines: the brief is plain text, and the
            # bullets are structure worth keeping rather than flattening.
            parts.append("\n".join(f"- {plain_mentions(i)}" for i in s.get("items", [])))
        elif s.get("type") == "text":
            parts.append(plain_mentions(s.get("text", "")))
    return _js_trim("\n\n".join(parts))


CASE_ENV_KEY = "CREATIO_WORKSPACE_CASE"

# Briefs live beside the workspace analyses, under the same git-ignored dir.
CASES_DIR: Path = ANALYSIS_DIR / "cases"

# Re-fetch rather than trust a brief older than this.
BRIEF_FRESH_HOURS = 24


class CaseNumberError(Exception):
    pass


_CASE_RE = re.compile(r"SR[0-9]{4,12}")


def validate_case_number(raw: Any) -> str:
    """Validate a case number.

    Deliberately strict: `SR` + 4-12 digits. That makes the value safe as a bare
    `KEY=VALUE` in `.env` AND safe as a filename with no sanitizing, which is why
    neither of those call sites needs an escaping step.

    Messages are written for the user — the UI shows them verbatim.
    """
    s = _js_trim(str(raw or "")).upper()
    if not s:
        raise CaseNumberError("Enter a case number.")
    if not _CASE_RE.fullmatch(s):
        raise CaseNumberError(
            f'"{raw}" doesn\'t look like a case number. Expected SR followed by 4-12 digits, e.g. SR00031980.'
        )
    return s


def get_bound_case() -> str:
    """The bound case number, or "" when nothing is bound. Reads `.env` live."""
    return (read_env_file().get(CASE_ENV_KEY) or "").strip().upper()


def set_bound_case(n: str) -> None:
    """Bind a case, or pass "" to clear the binding."""
    write_env_file({CASE_ENV_KEY: validate_case_number(n) if n else ""})


# CaseBrief keys (JSON, camelCase as in TS):
#   version (1), number, id, subject, status, owner, account, contact,
#   createdOn, description (plain text only — nothing downstream renders it as
#   HTML), timeline [{kind, ts, text, title?, sender?, author?}],
#   timelineTruncated (the 50-row per-entity cap was probably hit),
#   attachments (metadata only — bytes stay in Creatio, fetched on demand
#   through the read-only /api/file proxy), fetchedAt, caveats,
#   info? [{label, value}] (Creatio's Case info panel, non-empty rows) and
#   codes? {districtCode?, schoolCode?, institutionId?} — which client the case
#   is about, so a fix lands in that district's folder. Absent on older briefs.

# Case info panel label → brief["codes"] key. The labels are the ones
# case_lookup.get_case_info emits.
_CODE_LABELS = {
    "SIS District code": "districtCode",
    "School Code": "schoolCode",
    "Institution ID Number": "institutionId",
}
# Rows the brief already carries as top-level keys, or that say nothing useful
# about which client or what kind of work.
_INFO_SKIP = {"Contact", "Account", "Resolution time"}


def info_from_case_info(rows: Sequence[Mapping[str, Any]] | None) -> tuple[list[dict], dict]:
    """Case info panel rows → (info, codes) for a brief. Empty values are dropped."""
    info: list[dict] = []
    codes: dict[str, str] = {}
    for r in rows or []:
        label = str(r.get("label") or "").strip()
        value = str(r.get("value") or "").strip()
        if not label or not value:
            continue
        if label in _CODE_LABELS:
            codes[_CODE_LABELS[label]] = value
        if label not in _INFO_SKIP:
            info.append({"label": label, "value": value})
    return info, codes


def with_case_info(b: dict[str, Any], rows: Sequence[Mapping[str, Any]] | None) -> dict[str, Any]:
    """Attach info/codes to a brief (in place) and return it."""
    b["info"], b["codes"] = info_from_case_info(rows)
    return b


def brief_path(number: str) -> Path:
    return CASES_DIR / f"{validate_case_number(number)}.json"


def build_brief(
    c: Mapping[str, Any],
    detail: Mapping[str, Any],
    attachments: Sequence[Mapping[str, Any]] | None = None,
) -> dict[str, Any]:
    """Build a brief from a case row plus its fetched detail.

    Only the stripped text is kept. Inline images and email attachments are
    dropped — a brief is a handoff, not an archive — and that loss is recorded
    in `caveats` so the skill can say so instead of assuming it saw everything.

    ``attachments=None`` means the list could not be read (see the allowlist
    caveat below).
    """
    tl = list(detail.get("timeline") or [])
    caveats: list[str] = []

    dropped = sum(len(t.get("images") or []) for t in tl)
    if dropped:
        caveats.append(
            f"{dropped} email attachment{'' if dropped == 1 else 's'} (screenshots) are not included in this brief — open the case in the app to see them."
        )

    truncated = len(tl) >= 50
    if truncated:
        caveats.append("The timeline hit the 50-row query cap, so older entries are missing.")

    if not detail.get("description"):
        caveats.append("The case has no description (Symptoms) text.")

    if attachments is None:
        caveats.append(
            "The case's attachments could not be listed. Add CaseFile to CREATIO_ALLOWED_ENTITIES in .env and restart the app."
        )
    elif attachments:
        # Worth stating plainly: a fix plan is produced from text, so an
        # attachment is context for the human, not something the planner has
        # looked inside.
        names = ", ".join(str(a.get("name")) for a in attachments)
        caveats.append(
            f"{len(attachments)} attachment{'' if len(attachments) == 1 else 's'} on the case ({names}) — open them yourself; their contents are not read when planning a fix."
        )

    timeline: list[dict[str, Any]] = []
    for t in tl:
        e: dict[str, Any] = {"kind": t.get("kind")}
        if "ts" in t:
            e["ts"] = t["ts"]
        e["text"] = _text_from_segments(t.get("segments")) or t.get("text") or ""
        for k in ("title", "sender", "author"):
            if t.get(k):
                e[k] = t[k]
        timeline.append(e)

    b = {
        "version": 1,
        "number": c.get("Number"),
        "id": c.get("Id"),
        "subject": c.get("Subject") or "",
        "status": c.get("Status") or "",
        "owner": c.get("Owner") or "",
        "account": c.get("Account") or "",
        "contact": c.get("Contact") or "",
        "createdOn": c.get("CreatedOn") or "",
        # Prefer the structure-preserving source; fall back to the flattened text.
        "description": _text_from_segments(detail.get("descriptionSegments"))
        or detail.get("description")
        or "",
        "timeline": timeline,
        "timelineTruncated": truncated,
        "attachments": [dict(a) for a in attachments] if attachments else [],
        "fetchedAt": iso_now(),
        "caveats": caveats,
    }
    if "caseInfo" in detail:
        with_case_info(b, detail.get("caseInfo"))
    return b


def save_brief(b: Mapping[str, Any]) -> str:
    """Persist a brief. Returns the absolute path written (as a string)."""
    target = brief_path(b["number"])
    write_atomic(target, json.dumps(b, indent=2, ensure_ascii=False))
    return str(target)


def load_brief(number: str) -> dict[str, Any] | None:
    """Load a stored brief, or None when there isn't one (or it's unreadable)."""
    try:
        path = brief_path(number)
    except CaseNumberError:
        return None  # not a valid number — treat as "no brief"
    try:
        parsed = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(parsed, dict) or not parsed.get("number"):
        return None
    if not isinstance(parsed.get("timeline"), list):
        parsed["timeline"] = []
    if not isinstance(parsed.get("caveats"), list):
        parsed["caveats"] = []
    return parsed


def brief_age_hours(b: Mapping[str, Any]) -> float:
    """How old a brief is, in hours. ``math.inf`` when the timestamp is unusable."""
    t = js_date_ms(b.get("fetchedAt"))
    if math.isnan(t):
        return math.inf
    return max(0.0, (time.time() * 1000 - t) / 3_600_000)


def is_brief_stale(b: Mapping[str, Any]) -> bool:
    return brief_age_hours(b) > BRIEF_FRESH_HOURS
