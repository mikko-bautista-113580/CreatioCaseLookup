"""Case lifecycle sample — the read-only recipe behind the Lifecycle tab.

CaseLifecycle holds one row per period a case spent in one state: Status,
Owner, Group, Priority, ServiceItem, with StartDate/EndDate. Creatio writes a
new row whenever ANY of those change, not only the status — so consecutive
rows can share a status (a reassignment, or the service item being set just
after creation). Substatus (Case.NltCaseSubStatus) is NOT recorded here.

Gotchas encoded below:
 - The final row's EndDate is 0001-01-01 (a sentinel), not null, and its
   StateDuration* columns are 0. It is normalised to None.
 - Filter through navigation paths (Case/Id, Case/Group/Id), never the FK
   columns — `NltCaseSubStatusId ne null` style filters fail.
 - A $filter is capped at 100 OData nodes, so a long OR-chain of case ids
   400s; lifecycle rows are read one case at a time instead.
"""

from __future__ import annotations

import asyncio
import re
from collections import Counter
from datetime import datetime
from typing import Any, Callable

from .creatio_client import ALLOWED_ENTITIES, MAX_TOP, query_records

LIFECYCLE_ENTITY = "CaseLifecycle"
WAITING = "Waiting for response"
ACTIVE = "In progress"
MAX_CASES = 300
_CONCURRENCY = 6

_GUID_RE = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")
_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_EMPTY_GUID = "00000000-0000-0000-0000-000000000000"


class LifecycleError(ValueError):
    """A request the Lifecycle tab can't run (bad input, entity not allowed)."""


def lifecycle_allowed() -> bool:
    return not ALLOWED_ENTITIES or LIFECYCLE_ENTITY in ALLOWED_ENTITIES


def _require_allowed() -> None:
    if not lifecycle_allowed():
        raise LifecycleError(
            f"{LIFECYCLE_ENTITY} is not in the allowlist. Add it to Allowed entities "
            "in Settings, then restart the app."
        )


def _guid(v: Any, what: str) -> str:
    if not isinstance(v, str) or not _GUID_RE.match(v):
        raise LifecycleError(f"Invalid {what}.")
    return v


def _name(r: dict, nav: str) -> str:
    v = r.get(nav)
    return (v.get("Name") or "") if isinstance(v, dict) else ""


def _dt(s: str | None) -> datetime | None:
    if not s or s.startswith("0001-"):
        return None
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


# ---------------------------------------------------------------------------
# Groups an owner works in — how the tab picks "our team" without SysAdminUnit
# ---------------------------------------------------------------------------
async def groups_for_owner(owner_id: str) -> list[dict[str, Any]]:
    """The assignee groups on this owner's recent cases, most frequent first."""
    _guid(owner_id, "owner id")
    rows = await query_records(
        "Case",
        filter=f"Owner/Id eq {owner_id}",
        select=["Id"],
        expand="Group($select=Id,Name)",
        orderby="CreatedOn desc",
        top=MAX_TOP,
    )
    counts: Counter[tuple[str, str]] = Counter()
    for r in rows:
        g = r.get("Group") if isinstance(r.get("Group"), dict) else {}
        gid = g.get("Id") or ""
        if gid and gid != _EMPTY_GUID:
            counts[(gid, g.get("Name") or "")] += 1
    return [{"Id": gid, "Name": name, "count": n} for (gid, name), n in counts.most_common()]


# ---------------------------------------------------------------------------
# Per-case analysis
# ---------------------------------------------------------------------------
def shape_rows(rows: list[dict]) -> list[dict[str, Any]]:
    out = []
    for r in sorted(rows, key=lambda x: x.get("StartDate") or ""):
        start, end = _dt(r.get("StartDate")), _dt(r.get("EndDate"))
        out.append(
            {
                "status": _name(r, "Status"),
                "owner": _name(r, "Owner"),
                "group": _name(r, "Group"),
                "start": r.get("StartDate"),
                "end": end.isoformat().replace("+00:00", "Z") if end else None,
                "minutes": round((end - start).total_seconds() / 60) if start and end else None,
            }
        )
    return out


def analyze_case(rows: list[dict[str, Any]]) -> dict[str, Any]:
    """Flags and totals for one case's shaped rows."""
    statuses = [r["status"] for r in rows]
    # Collapse consecutive duplicates: the status arc a person would describe.
    arc: list[str] = []
    for s in statuses:
        if not arc or arc[-1] != s:
            arc.append(s)
    bounces = sum(1 for a, b in zip(arc, arc[1:]) if a == WAITING and b == ACTIVE)
    # A handoff often passes through a row with no owner (Amy -> "" -> Melody);
    # count changes between the named owners so that is one reassignment.
    owners = [r["owner"] for r in rows if r["owner"]]
    reassignments = sum(1 for a, b in zip(owners, owners[1:]) if a != b)
    reassign_rows = sum(
        1 for a, b in zip(rows, rows[1:]) if a["status"] == b["status"] and a["owner"] != b["owner"]
    )
    minutes: Counter[str] = Counter()
    for r in rows:
        if r["minutes"] is not None:
            minutes[r["status"]] += r["minutes"]
    return {
        "arc": arc,
        "rowCount": len(rows),
        "bounces": bounces,
        "reassignments": reassignments,
        "reassignOnlyRows": reassign_rows,
        "fullArc": {"New", ACTIVE, WAITING, "Resolved", "Closed"} <= set(arc),
        "minutesByStatus": dict(minutes),
    }


# ---------------------------------------------------------------------------
# The sample
# ---------------------------------------------------------------------------
Progress = Callable[[dict[str, Any]], None]


def _noop(_: dict[str, Any]) -> None:
    pass


async def _closed_cases(group_id: str, since: str, max_cases: int, progress: Progress = _noop) -> list[dict]:
    """Closed cases of a group created on/after `since`, newest first, paged
    back by CreatedOn (the client clamps $top and has no $skip)."""
    cases: list[dict] = []
    before: str | None = None
    while len(cases) < max_cases:
        progress({"phase": "cases", "done": len(cases), "total": max_cases})
        clauses = [f"Group/Id eq {group_id}", "Status/Name eq 'Closed'", f"CreatedOn ge {since}T00:00:00Z"]
        if before:
            clauses.append(f"CreatedOn lt {before}")
        page = await query_records(
            "Case",
            filter=" and ".join(clauses),
            select=["Id", "Number", "Subject", "CreatedOn", "ClosureDate", "NltDateNeeded"],
            expand="Owner($select=Name),NltCaseSubStatus($select=Name)",
            orderby="CreatedOn desc",
            top=MAX_TOP,
        )
        cases.extend(page)
        if len(page) < MAX_TOP:
            break
        before = page[-1]["CreatedOn"]
    return cases[:max_cases]


async def _rows_for(case_id: str) -> tuple[list[dict], bool]:
    rows = await query_records(
        LIFECYCLE_ENTITY,
        filter=f"Case/Id eq {case_id}",
        expand="Status($select=Name),Owner($select=Name),Group($select=Name)",
        orderby="StartDate asc",
        top=MAX_TOP,
    )
    return rows, len(rows) >= MAX_TOP


def validate_request(group_id: Any, since: Any, max_cases: Any) -> tuple[str, str, int]:
    """Check a sample request before any Creatio call (or stream) starts."""
    _require_allowed()
    _guid(group_id, "group id")
    if not isinstance(since, str) or not _DATE_RE.match(since):
        raise LifecycleError("Invalid start date (expected YYYY-MM-DD).")
    try:
        n = max(1, min(MAX_CASES, int(max_cases)))
    except (TypeError, ValueError):
        raise LifecycleError("Invalid case count.") from None
    return group_id, since, n


async def lifecycle_sample(
    group_id: str, since: str, max_cases: int = 100, progress: Progress = _noop
) -> dict[str, Any]:
    """Every lifecycle row for up to `max_cases` closed cases of a group.

    `progress` gets ``{"phase": "cases"|"rows", "done", "total"}`` as the case
    list pages in and then as each case's rows arrive."""
    group_id, since, max_cases = validate_request(group_id, since, max_cases)

    cases = await _closed_cases(group_id, since, max_cases, progress)
    sem = asyncio.Semaphore(_CONCURRENCY)
    done = {"n": 0}
    progress({"phase": "rows", "done": 0, "total": len(cases)})

    async def one(c: dict) -> dict[str, Any]:
        async with sem:
            raw, capped = await _rows_for(c["Id"])
        done["n"] += 1
        progress({"phase": "rows", "done": done["n"], "total": len(cases)})
        rows = shape_rows(raw)
        return {
            "Id": c["Id"],
            "Number": c.get("Number"),
            "Subject": c.get("Subject"),
            "CreatedOn": c.get("CreatedOn"),
            "ClosureDate": c.get("ClosureDate"),
            "DateNeeded": c.get("NltDateNeeded"),
            "Owner": _name(c, "Owner"),
            "SubStatus": _name(c, "NltCaseSubStatus"),
            "rows": rows,
            "rowsCapped": capped,
            **analyze_case(rows),
        }

    out = await asyncio.gather(*(one(c) for c in cases))
    return {"cases": out, "summary": summarize(out)}


def summarize(cases: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "cases": len(cases),
        "rows": sum(c["rowCount"] for c in cases),
        "fullArc": sum(1 for c in cases if c["fullArc"]),
        "bounced": sum(1 for c in cases if c["bounces"] >= 2),
        "reassigned": sum(1 for c in cases if c["reassignments"] > 0),
        "reassignOnlyRows": sum(c["reassignOnlyRows"] for c in cases),
        "capped": sum(1 for c in cases if c["rowsCapped"]),
    }
