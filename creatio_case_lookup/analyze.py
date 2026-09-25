"""AI analysis of Creatio cases via the locally-installed Claude Code CLI.

This module owns only the case-specific parts: the preset instructions, the
system prompt, and how case rows are flattened into text. The process
plumbing lives in :mod:`creatio_case_lookup.claude_run`.

INJECTION BOUNDARY: the ``-p`` argument is a fixed, app-authored instruction.
ALL untrusted content (case data + the user's free-text question) is written
to the child's stdin, never interpolated into argv or a shell string.

Case text is raw third-party prose, so these runs use ``cwd="isolated"`` with
no tools and no setting sources — the child can reason about the text but has
no filesystem to act on. See the injection-boundary docstring in claude_run.py.
"""

from __future__ import annotations

import asyncio
import os
from typing import Any, Callable, Literal, TypedDict

from .claude_run import ClaudeCliError, RunHandle, RunSpec, claude_available, run_claude

# Re-exported so existing importers (server.py) keep working unchanged.
__all__ = [
    "DEFAULT_MODEL",
    "Preset",
    "PRESET_INSTRUCTIONS",
    "SYSTEM_PROMPT",
    "ASK_INSTRUCTION",
    "MAX_CASES",
    "MAX_TIMELINE_PER_CASE",
    "MAX_TEXT",
    "clip",
    "format_case",
    "build_context",
    "analyze_cases",
    "claude_available",
    "ClaudeCliError",
]

# ---------------------------------------------------------------------------
# Default model for analysis. Overridable per-run (CREATIO_APP_MODEL); set to
# a cheaper tier (e.g. "claude-sonnet-5", "claude-haiku-4-5") for faster runs.
# ---------------------------------------------------------------------------
DEFAULT_MODEL = "claude-opus-5"


def default_model() -> str:
    """The model for the app's runs: CREATIO_APP_MODEL (environment, then .env),
    else the `model` in this project's .claude/settings.json, else DEFAULT_MODEL.
    Passed as --model, which would otherwise override the settings file's."""
    from .claude_run import app_settings
    from .env import read_env_file

    return (
        os.environ.get("CREATIO_APP_MODEL")
        or (read_env_file().get("CREATIO_APP_MODEL") or "").strip()
        or app_settings().get("model")
        or DEFAULT_MODEL
    )

# ---------------------------------------------------------------------------
# Preset instructions
# ---------------------------------------------------------------------------
Preset = Literal["summarize", "themes", "actions", "ask"]

PRESET_INSTRUCTIONS: dict[str, str] = {
    "summarize": (
        "Summarize and prioritize the Creatio support cases provided on stdin. "
        "Give a 2-3 sentence overview, then a ranked list (most urgent first) of which "
        "cases need attention and a short 'why' for each (age, who is blocking, severity)."
    ),
    "themes": (
        "Analyze the Creatio support cases provided on stdin and group them by common "
        "theme or underlying root cause (e.g. report-card template bugs, setup/config "
        "issues, data problems). For each theme list the case numbers and a one-line "
        "explanation of the shared cause."
    ),
    "actions": (
        "For each Creatio support case provided on stdin, state the single most useful "
        "next action and who is currently blocking it (client vs support). Keep each "
        "case to 1-2 lines, formatted as a list keyed by case number."
    ),
}

ASK_INSTRUCTION = (
    "Answer the user's QUESTION (below) using ONLY the Creatio support-case data on stdin."
)

SYSTEM_PROMPT = (
    "You are a concise support-operations analyst for a school-information-system (SIS) "
    "team that customizes report-card templates in Creatio. You are given support-case "
    "data (numbers, subjects, statuses, accounts, descriptions, and a merged timeline of "
    "feed posts and emails). Analyze ONLY the data provided on stdin — do not invent facts "
    "or use any tools. Note: timeline authors are unresolved, so never assert who wrote a "
    "post; refer to content and @mentions only. Answer in clear, well-structured Markdown."
)

# ---------------------------------------------------------------------------
# Context formatting
# ---------------------------------------------------------------------------
MAX_CASES = 25  # keep token use / latency sane
MAX_TIMELINE_PER_CASE = 12
MAX_TEXT = 1000  # chars per description / timeline entry


class BuildContextResult(TypedDict):
    text: str
    truncatedCases: int


def _trim(s: str) -> str:
    # JS String.prototype.trim also strips U+FEFF; Python's strip() does not.
    return s.strip().strip("﻿").strip()


def clip(s: str | None, n: int = MAX_TEXT) -> str:
    t = _trim(s or "")
    return t[:n] + " …[truncated]" if len(t) > n else t


def _s(v: Any) -> str:
    """JS template-literal stringification for the fields we print."""
    if v is None:
        return "undefined"
    return str(v)


def format_case(c: dict, i: int) -> str:
    """`c` is a CaseRow dict (camel/Pascal keys as from Creatio) plus optional
    ``detail`` (a CaseDetail dict)."""
    lines: list[str] = []
    lines.append(f"### Case {i + 1}: {_s(c.get('Number'))} — {_s(c.get('Subject'))}")
    lines.append(
        f"Status: {_s(c.get('Status'))} | Account: {c.get('Account') or '?'} | "
        f"Contact: {c.get('Contact') or '?'} | Created: {_s(c.get('CreatedOn'))}"
    )
    d = c.get("detail") or {}
    if d.get("description"):
        lines.append(f"Description: {clip(d['description'])}")
    tl: list[dict] = d.get("timeline") or ([d["latest"]] if d.get("latest") else [])
    if tl:
        shown = tl[-MAX_TIMELINE_PER_CASE:]
        omitted = len(tl) - len(shown)
        lines.append(
            f"Timeline ({len(tl)} entr{'y' if len(tl) == 1 else 'ies'}"
            f"{f', showing last {len(shown)}' if omitted > 0 else ''}):"
        )
        for e in shown:
            who = (
                f"{e.get('sender') or '?'} → {e.get('recipient') or '?'}"
                if e.get("kind") == "EMAIL"
                else "feed post"
            )
            lines.append(f"- [{_s(e.get('kind'))} {_s(e.get('ts'))}] ({who}) {clip(e.get('text'), 500)}")
    return "\n".join(lines)


def build_context(cases: list[dict]) -> BuildContextResult:
    truncated_cases = max(0, len(cases) - MAX_CASES)
    use = cases[:MAX_CASES]
    blocks = [format_case(c, i) for i, c in enumerate(use)]
    header = (
        f"# {len(use)} Creatio support case{'' if len(use) == 1 else 's'}"
        + (
            f" (of {len(cases)}; {truncated_cases} omitted to keep the analysis focused)"
            if truncated_cases > 0
            else ""
        )
        + "\n"
    )
    return {"text": header + "\n" + "\n\n".join(blocks), "truncatedCases": truncated_cases}


# ---------------------------------------------------------------------------
# Runner
# ---------------------------------------------------------------------------
def analyze_cases(
    opts: dict,
    on_chunk: Callable[[str], None],
    on_done: Callable[[dict], None],
    on_error: Callable[[ClaudeCliError], None],
) -> RunHandle:
    """Run an analysis, streaming text chunks via callbacks. Never raises — all
    outcomes are delivered through on_done / on_error.

    ``opts`` keys (TS AnalyzeOptions): ``preset`` (required), ``question``
    (required when preset == "ask"), ``cases``, ``model`` (defaults to
    DEFAULT_MODEL), ``cancel`` (an ``asyncio.Event``; the TS ``signal``).
    ``on_done`` gets the run meta plus ``truncatedCases``.
    """
    preset = opts["preset"]
    instruction = ASK_INSTRUCTION if preset == "ask" else PRESET_INSTRUCTIONS[preset]

    ctx = build_context(opts.get("cases") or [])
    context, truncated_cases = ctx["text"], ctx["truncatedCases"]
    question = _trim(opts.get("question") or "")
    stdin = (f"QUESTION: {question}\n\n" if preset == "ask" and question else "") + context

    cancel: asyncio.Event | None = opts.get("cancel") or opts.get("signal")
    return run_claude(
        RunSpec(
            instruction=instruction,
            system_prompt=SYSTEM_PROMPT,
            stdin=stdin,
            # Untrusted prose in, no filesystem to act on: no tools, no repo context.
            cwd="isolated",
            setting_sources=[],
            model=opts.get("model") or default_model(),
            cancel=cancel,
        ),
        on_chunk=on_chunk,
        on_done=lambda meta: on_done({**meta, "truncatedCases": truncated_cases}),
        on_error=on_error,
    )
