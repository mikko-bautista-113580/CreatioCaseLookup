/**
 * AI analysis of Creatio cases via the locally-installed Claude Code CLI.
 *
 * This module owns only the case-specific parts: the preset instructions, the
 * system prompt, and how case rows are flattened into text. The process
 * plumbing lives in ./shared/claudeRun.ts.
 *
 * INJECTION BOUNDARY: the `-p` argument is a fixed, app-authored instruction.
 * ALL untrusted content (case data + the user's free-text question) is written
 * to the child's stdin, never interpolated into argv or a shell string.
 *
 * Case text is raw third-party prose, so these runs use `cwd: "isolated"` with
 * no tools and no setting sources — the child can reason about the text but has
 * no filesystem to act on. See the injection-boundary comment in claudeRun.ts.
 */

import { runClaude, claudeAvailable, ClaudeCliError } from "./shared/claudeRun.js";
import type { CaseRow, CaseDetail, TimelineEntry } from "./caseLookup.js";

// Re-exported so existing importers (src/server.ts) keep working unchanged.
export { claudeAvailable, ClaudeCliError };

// ---------------------------------------------------------------------------
// Default model for analysis. Overridable per-run (CREATIO_APP_MODEL); set to
// a cheaper tier (e.g. "claude-sonnet-5", "claude-haiku-4-5") for faster runs.
// ---------------------------------------------------------------------------
export const DEFAULT_MODEL = "claude-opus-5";

// ---------------------------------------------------------------------------
// Preset instructions
// ---------------------------------------------------------------------------
export type Preset = "summarize" | "themes" | "actions" | "ask";

const PRESET_INSTRUCTIONS: Record<Exclude<Preset, "ask">, string> = {
  summarize:
    "Summarize and prioritize the Creatio support cases provided on stdin. " +
    "Give a 2-3 sentence overview, then a ranked list (most urgent first) of which " +
    "cases need attention and a short 'why' for each (age, who is blocking, severity).",
  themes:
    "Analyze the Creatio support cases provided on stdin and group them by common " +
    "theme or underlying root cause (e.g. report-card template bugs, setup/config " +
    "issues, data problems). For each theme list the case numbers and a one-line " +
    "explanation of the shared cause.",
  actions:
    "For each Creatio support case provided on stdin, state the single most useful " +
    "next action and who is currently blocking it (client vs support). Keep each " +
    "case to 1-2 lines, formatted as a list keyed by case number.",
};

const SYSTEM_PROMPT =
  "You are a concise support-operations analyst for a school-information-system (SIS) " +
  "team that customizes report-card templates in Creatio. You are given support-case " +
  "data (numbers, subjects, statuses, accounts, descriptions, and a merged timeline of " +
  "feed posts and emails). Analyze ONLY the data provided on stdin — do not invent facts " +
  "or use any tools. Note: timeline authors are unresolved, so never assert who wrote a " +
  "post; refer to content and @mentions only. Answer in clear, well-structured Markdown.";

// ---------------------------------------------------------------------------
// Context formatting
// ---------------------------------------------------------------------------
const MAX_CASES = 25; // keep token use / latency sane
const MAX_TIMELINE_PER_CASE = 12;
const MAX_TEXT = 1000; // chars per description / timeline entry

export interface AnalyzableCase extends CaseRow {
  detail?: CaseDetail;
}

function clip(s: string | undefined | null, n = MAX_TEXT): string {
  const t = (s || "").trim();
  return t.length > n ? t.slice(0, n) + " …[truncated]" : t;
}

function formatCase(c: AnalyzableCase, i: number): string {
  const lines: string[] = [];
  lines.push(`### Case ${i + 1}: ${c.Number} — ${c.Subject}`);
  lines.push(
    `Status: ${c.Status} | Account: ${c.Account || "?"} | Contact: ${c.Contact || "?"} | Created: ${c.CreatedOn}`
  );
  const d = c.detail || {};
  if (d.description) lines.push(`Description: ${clip(d.description)}`);
  const tl: TimelineEntry[] = d.timeline || (d.latest ? [d.latest] : []);
  if (tl.length) {
    const shown = tl.slice(-MAX_TIMELINE_PER_CASE);
    const omitted = tl.length - shown.length;
    lines.push(`Timeline (${tl.length} entr${tl.length === 1 ? "y" : "ies"}${omitted > 0 ? `, showing last ${shown.length}` : ""}):`);
    for (const e of shown) {
      const who = e.kind === "EMAIL" ? `${e.sender || "?"} → ${e.recipient || "?"}` : "feed post";
      lines.push(`- [${e.kind} ${e.ts}] (${who}) ${clip(e.text, 500)}`);
    }
  }
  return lines.join("\n");
}

export interface BuildContextResult {
  text: string;
  truncatedCases: number;
}

export function buildContext(cases: AnalyzableCase[]): BuildContextResult {
  const truncatedCases = Math.max(0, cases.length - MAX_CASES);
  const use = cases.slice(0, MAX_CASES);
  const blocks = use.map(formatCase);
  const header =
    `# ${use.length} Creatio support case${use.length === 1 ? "" : "s"}` +
    (truncatedCases > 0 ? ` (of ${cases.length}; ${truncatedCases} omitted to keep the analysis focused)` : "") +
    "\n";
  return { text: header + "\n" + blocks.join("\n\n"), truncatedCases };
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------
export interface AnalyzeOptions {
  preset: Preset;
  question?: string; // required when preset === 'ask'
  cases: AnalyzableCase[];
  model?: string; // optional override; defaults to DEFAULT_MODEL
  signal?: AbortSignal;
}

export interface AnalyzeCallbacks {
  onChunk: (text: string) => void;
  onDone: (meta: { costUsd?: number; totalTokens?: number; durationMs?: number; truncatedCases: number }) => void;
  onError: (err: ClaudeCliError) => void;
}

/**
 * Run an analysis, streaming text chunks via callbacks. Never rejects — all
 * outcomes are delivered through onDone / onError.
 */
export function analyzeCases(opts: AnalyzeOptions, cb: AnalyzeCallbacks): { kill: () => void } {
  const instruction =
    opts.preset === "ask"
      ? "Answer the user's QUESTION (below) using ONLY the Creatio support-case data on stdin."
      : PRESET_INSTRUCTIONS[opts.preset];

  const { text: context, truncatedCases } = buildContext(opts.cases);
  const question = (opts.question || "").trim();
  const stdin =
    (opts.preset === "ask" && question ? `QUESTION: ${question}\n\n` : "") + context;

  return runClaude(
    {
      instruction,
      systemPrompt: SYSTEM_PROMPT,
      stdin,
      // Untrusted prose in, no filesystem to act on: no tools, no repo context.
      cwd: "isolated",
      settingSources: [],
      model: opts.model || DEFAULT_MODEL,
      signal: opts.signal,
    },
    {
      onChunk: cb.onChunk,
      onDone: (meta) => cb.onDone({ ...meta, truncatedCases }),
      onError: cb.onError,
    }
  );
}
