/**
 * The bound Creatio case: the pointer, and the stored brief.
 *
 * The Workspace tab is case-first — you pick the case, then the folders, then
 * hand off to the `creatio-case-fix` skill. Two pieces of durable state make
 * that survive a browser reload AND a fresh Claude Code session:
 *
 *   .env  CREATIO_WORKSPACE_CASE    the pointer: which case is bound
 *   .analysis/cases/<NUMBER>.json   the brief: subject, description, timeline
 *
 * The server is stateless by design (every route derives its inputs from the
 * request plus `.env` / `.analysis/`), so there is nowhere else for a binding
 * to live.
 *
 * ---------------------------------------------------------------------------
 * TRUST BOUNDARY — read this before wiring this module anywhere new.
 *
 * A brief holds case text written by CLIENTS and third parties. It is prose
 * from outside, and it is DATA, never instructions.
 *
 * `src/analyzeWorkspace.ts` must NEVER import this module, and
 * `buildWorkspaceStdin()` must never gain case text. That run gets a real cwd
 * plus Read/Glob/Grep over the user's folders; feeding third-party prose into
 * it is the one combination `src/shared/claudeRun.ts` warns against.
 *
 * The brief is consumed by (a) the Workspace tab, for display, and (b) the
 * `creatio-case-fix` skill running in the user's own interactive session,
 * behind its explicit approval gate. Both are fine. A child process with file
 * access is not.
 * ---------------------------------------------------------------------------
 */

import { join } from "node:path";
import { readFileSync } from "node:fs";

import { readEnvFile, writeEnvFile } from "./creatioClient.js";
import { ANALYSIS_DIR, writeAtomic } from "./workspace.js";
import type {
  CaseAttachment,
  CaseDetail,
  CaseRow,
  Segment,
  TimelineEntry,
} from "./caseLookup.js";
import { plainMentions } from "./caseLookup.js";

/**
 * Plain text from rich segments, keeping the paragraph breaks.
 *
 * `strip()` ends with `\s+ -> " "`, which flattens a numbered request list into
 * one unreadable line. htmlToSegments() already turns `</p>`, `</div>`, `</li>`
 * and `<br>` into newlines, so the segments are the better source when we have
 * them — a case's "1) ... 2) ... 3) ..." survives as a list.
 */
function textFromSegments(segments: Segment[] | undefined): string {
  return (segments || [])
    .filter((s) => s.type === "text" || s.type === "list")
    // A list becomes "- item" lines: the brief is plain text, and the bullets
    // are structure worth keeping rather than flattening into a paragraph.
    .map((s) =>
      s.type === "list"
        ? s.items.map((i) => `- ${plainMentions(i)}`).join("\n")
        : plainMentions((s as Extract<Segment, { type: "text" }>).text)
    )
    .join("\n\n")
    .trim();
}

export const CASE_ENV_KEY = "CREATIO_WORKSPACE_CASE";

/** Briefs live beside the workspace analyses, under the same git-ignored dir. */
export const CASES_DIR = join(ANALYSIS_DIR, "cases");

/** Re-fetch rather than trust a brief older than this. */
export const BRIEF_FRESH_HOURS = 24;

export class CaseNumberError extends Error {}

/**
 * Validate a case number.
 *
 * Deliberately strict: `SR` + 4-12 digits. That makes the value safe as a bare
 * `KEY=VALUE` in `.env` AND safe as a filename with no sanitizing, which is why
 * neither of those call sites needs an escaping step.
 *
 * Messages are written for the user — the UI shows them verbatim.
 */
export function validateCaseNumber(raw: string): string {
  const s = String(raw || "").trim().toUpperCase();
  if (!s) throw new CaseNumberError("Enter a case number.");
  if (!/^SR\d{4,12}$/.test(s)) {
    throw new CaseNumberError(
      `"${raw}" doesn't look like a case number. Expected SR followed by 4-12 digits, e.g. SR00031980.`
    );
  }
  return s;
}

/** The bound case number, or "" when nothing is bound. Reads `.env` live. */
export function getBoundCase(): string {
  return (readEnvFile()[CASE_ENV_KEY] || "").trim().toUpperCase();
}

/** Bind a case, or pass "" to clear the binding. */
export function setBoundCase(n: string): void {
  writeEnvFile({ [CASE_ENV_KEY]: n ? validateCaseNumber(n) : "" });
}

export interface BriefTimelineEntry {
  kind: "FEED" | "EMAIL";
  ts: string;
  text: string;
  title?: string;
  sender?: string;
  /** Who posted, resolved to a Contact name; absent when unresolved. */
  author?: string;
}

export interface CaseBrief {
  version: 1;
  number: string;
  id: string;
  subject: string;
  status: string;
  owner: string;
  account: string;
  contact: string;
  createdOn: string;
  /** Plain text only — nothing downstream renders this as HTML. */
  description: string;
  timeline: BriefTimelineEntry[];
  /** The 50-row per-entity cap was probably hit; the timeline is partial. */
  timelineTruncated: boolean;
  /**
   * Files on the case's Attachments tab — metadata only. The bytes stay in
   * Creatio and are fetched on demand through the read-only /api/file proxy.
   */
  attachments: CaseAttachment[];
  fetchedAt: string;
  caveats: string[];
}

export function briefPath(number: string): string {
  return join(CASES_DIR, `${validateCaseNumber(number)}.json`);
}

/**
 * Build a brief from a case row plus its fetched detail.
 *
 * Only the stripped text is kept. Inline images and email attachments are
 * dropped — a brief is a handoff, not an archive — and that loss is recorded
 * in `caveats` so the skill can say so instead of assuming it saw everything.
 */
export function buildBrief(
  c: CaseRow,
  detail: CaseDetail,
  /** null means the list could not be read (see the allowlist note below). */
  attachments: CaseAttachment[] | null = null
): CaseBrief {
  const tl: TimelineEntry[] = detail.timeline || [];
  const caveats: string[] = [];

  let dropped = 0;
  for (const t of tl) dropped += (t.images?.length || 0);
  if (dropped) {
    caveats.push(
      `${dropped} email attachment${dropped === 1 ? "" : "s"} (screenshots) are not included in this brief — open the case in the app to see them.`
    );
  }

  const truncated = tl.length >= 50;
  if (truncated) {
    caveats.push(
      "The timeline hit the 50-row query cap, so older entries are missing."
    );
  }

  if (!detail.description) {
    caveats.push("The case has no description (Symptoms) text.");
  }

  if (attachments === null) {
    caveats.push(
      "The case's attachments could not be listed. Add CaseFile to CREATIO_ALLOWED_ENTITIES in .env and restart the app."
    );
  } else if (attachments.length) {
    // Worth stating plainly: a fix plan is produced from text, so an attachment
    // is context for the human, not something the planner has looked inside.
    caveats.push(
      `${attachments.length} attachment${attachments.length === 1 ? "" : "s"} on the case (${attachments
        .map((a) => a.name)
        .join(", ")}) — open them yourself; their contents are not read when planning a fix.`
    );
  }

  return {
    version: 1,
    number: c.Number,
    id: c.Id,
    subject: c.Subject || "",
    status: c.Status || "",
    owner: c.Owner || "",
    account: c.Account || "",
    contact: c.Contact || "",
    createdOn: c.CreatedOn || "",
    // Prefer the structure-preserving source; fall back to the flattened text.
    description: textFromSegments(detail.descriptionSegments) || detail.description || "",
    timeline: tl.map((t) => ({
      kind: t.kind,
      ts: t.ts,
      text: textFromSegments(t.segments) || t.text || "",
      ...(t.title ? { title: t.title } : {}),
      ...(t.sender ? { sender: t.sender } : {}),
      ...(t.author ? { author: t.author } : {}),
    })),
    timelineTruncated: truncated,
    attachments: attachments || [],
    fetchedAt: new Date().toISOString(),
    caveats,
  };
}

/** Persist a brief. Returns the absolute path written. */
export function saveBrief(b: CaseBrief): string {
  const target = briefPath(b.number);
  writeAtomic(target, JSON.stringify(b, null, 2));
  return target;
}

/** Load a stored brief, or null when there isn't one (or it's unreadable). */
export function loadBrief(number: string): CaseBrief | null {
  let path: string;
  try {
    path = briefPath(number);
  } catch {
    return null; // not a valid number — treat as "no brief"
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || !parsed.number) return null;
    if (!Array.isArray(parsed.timeline)) parsed.timeline = [];
    if (!Array.isArray(parsed.caveats)) parsed.caveats = [];
    return parsed as CaseBrief;
  } catch {
    return null;
  }
}

/** How old a brief is, in hours. `Infinity` when the timestamp is unusable. */
export function briefAgeHours(b: CaseBrief): number {
  const t = Date.parse(b.fetchedAt);
  if (Number.isNaN(t)) return Infinity;
  return Math.max(0, (Date.now() - t) / 3_600_000);
}

export function isBriefStale(b: CaseBrief): boolean {
  return briefAgeHours(b) > BRIEF_FRESH_HOURS;
}
