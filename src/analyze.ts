/**
 * AI analysis of Creatio cases via the locally-installed Claude Code CLI.
 *
 * We spawn `claude -p` in headless, streaming mode using the user's existing
 * Claude login (OAuth/subscription) — no API key needed. The child is fully
 * isolated: no MCP servers, no tools that would block on a permission prompt,
 * and an empty temp cwd so it never auto-loads this repo's CLAUDE.md / settings.
 *
 * INJECTION BOUNDARY: the `-p` argument is a fixed, app-authored instruction.
 * ALL untrusted content (case data + the user's free-text question) is written
 * to the child's stdin, never interpolated into argv or a shell string. The
 * child is spawned with shell:false.
 */

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CaseRow, CaseDetail, TimelineEntry } from "./caseLookup.js";

// ---------------------------------------------------------------------------
// Default model for analysis. Overridable per-run (CREATIO_APP_MODEL); set to
// a cheaper tier (e.g. "claude-sonnet-5", "claude-haiku-4-5") for faster runs.
// ---------------------------------------------------------------------------
export const DEFAULT_MODEL = "claude-opus-5";

// ---------------------------------------------------------------------------
// Locate the claude binary once.
// ---------------------------------------------------------------------------
let CLAUDE_BIN: string | null | undefined;

function resolveClaudeBin(): string | null {
  if (CLAUDE_BIN !== undefined) return CLAUDE_BIN;
  const isWin = process.platform === "win32";
  const finder = isWin ? "where" : "which";
  try {
    const r = spawnSync(finder, ["claude"], { encoding: "utf8" });
    const line = (r.stdout || "")
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    // On Windows prefer the .cmd shim (spawnable with shell:false).
    const pick = isWin ? line.find((l) => /\.cmd$/i.test(l)) || line[0] : line[0];
    CLAUDE_BIN = pick || null;
  } catch {
    CLAUDE_BIN = null;
  }
  return CLAUDE_BIN;
}

export function claudeAvailable(): boolean {
  return Boolean(resolveClaudeBin());
}

/** Quote one command-line token for the Windows shell. Wraps in double quotes
 *  and doubles any embedded quotes. Only ever applied to app-authored args. */
function winQuote(a: string): string {
  return '"' + String(a).replace(/"/g, '""') + '"';
}

export class ClaudeCliError extends Error {
  constructor(
    message: string,
    public readonly kind: "not_installed" | "not_logged_in" | "failed" = "failed"
  ) {
    super(message);
  }
}

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
  const bin = resolveClaudeBin();
  if (!bin) {
    cb.onError(
      new ClaudeCliError(
        "The Claude CLI was not found. Install it (npm i -g @anthropic-ai/claude-code) and run `claude` once to log in.",
        "not_installed"
      )
    );
    return { kill: () => {} };
  }

  const instruction =
    opts.preset === "ask"
      ? "Answer the user's QUESTION (below) using ONLY the Creatio support-case data on stdin."
      : PRESET_INSTRUCTIONS[opts.preset];

  const { text: context, truncatedCases } = buildContext(opts.cases);
  const question = (opts.question || "").trim();
  const stdin =
    (opts.preset === "ask" && question ? `QUESTION: ${question}\n\n` : "") + context;

  const args = [
    "-p",
    instruction,
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--strict-mcp-config", // no --mcp-config => all MCP servers disabled
    "--permission-mode",
    "dontAsk", // never blocks on an interactive permission prompt
    "--append-system-prompt",
    SYSTEM_PROMPT,
  ];
  args.push("--model", opts.model || DEFAULT_MODEL);

  let cwd: string;
  try {
    cwd = mkdtempSync(join(tmpdir(), "creatio-analyze-"));
  } catch {
    cwd = tmpdir();
  }

  // Windows refuses to spawn a .cmd shim with shell:false (EINVAL), so on Windows
  // we go through the shell. This stays injection-safe because EVERY arg here is
  // app-authored (flags + fixed instruction/system prompt) and individually
  // quoted; all untrusted content (case data + the user's question) is on stdin,
  // never on the command line. On other platforms we spawn directly (no shell).
  const isWin = process.platform === "win32";
  const child = isWin
    ? spawn([bin, ...args].map(winQuote).join(" "), {
        cwd,
        shell: true,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
        signal: opts.signal,
      })
    : spawn(bin, args, {
        cwd,
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
        signal: opts.signal,
      });

  let stderr = "";
  let buffer = "";
  let finished = false;
  let meta: { costUsd?: number; totalTokens?: number; durationMs?: number } = {};
  let streamedAny = false; // did we get any streamed text deltas?
  let resultText = ""; // final `result` text (fallback if deltas didn't stream)
  let isError = false; // Claude reported an error result
  let errorInfo = ""; // subtype / api_error_status for a clearer message

  const TIMEOUT_MS = 120_000;
  const timer = setTimeout(() => {
    if (!finished) {
      finished = true;
      try { child.kill(); } catch { /* ignore */ }
      cb.onError(new ClaudeCliError("The analysis timed out after 120s.", "failed"));
    }
  }, TIMEOUT_MS);

  function handleLine(line: string): void {
    const s = line.trim();
    if (!s) return;
    let obj: any;
    try {
      obj = JSON.parse(s);
    } catch {
      return; // ignore non-JSON noise
    }
    if (obj.type === "stream_event") {
      const ev = obj.event;
      if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta") {
        streamedAny = true;
        cb.onChunk(ev.delta.text || "");
      }
    } else if (obj.type === "result") {
      if (typeof obj.result === "string") resultText = obj.result;
      if (obj.is_error) isError = true;
      if (obj.subtype && obj.subtype !== "success") errorInfo = String(obj.subtype);
      if (obj.api_error_status) errorInfo = `API ${obj.api_error_status}`;
      if (obj.error) errorInfo = typeof obj.error === "string" ? obj.error : JSON.stringify(obj.error).slice(0, 200);
      if (typeof obj.total_cost_usd === "number") meta.costUsd = obj.total_cost_usd;
      if (obj.usage?.total_tokens) meta.totalTokens = obj.usage.total_tokens;
      else if (obj.usage) {
        const u = obj.usage;
        meta.totalTokens = (u.input_tokens || 0) + (u.output_tokens || 0) || undefined;
      }
      if (typeof obj.duration_ms === "number") meta.durationMs = obj.duration_ms;
    }
  }

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (d: string) => {
    buffer += d;
    let nl: number;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      handleLine(buffer.slice(0, nl));
      buffer = buffer.slice(nl + 1);
    }
  });

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (d: string) => {
    stderr += d;
  });

  child.on("error", (err: NodeJS.ErrnoException) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    if (err.code === "ENOENT") {
      cb.onError(new ClaudeCliError("The Claude CLI could not be launched.", "not_installed"));
    } else {
      cb.onError(new ClaudeCliError(`Failed to run Claude: ${err.message}`, "failed"));
    }
  });

  child.on("close", (code) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    if (buffer.trim()) handleLine(buffer);

    // Some runs deliver the whole answer in the final `result` line rather than
    // as streamed deltas — surface it so the panel isn't blank.
    if (!streamedAny && resultText && !isError) cb.onChunk(resultText);

    if (code === 0 && !isError) {
      cb.onDone({ ...meta, truncatedCases });
      return;
    }

    const blob = `${stderr} ${errorInfo} ${resultText}`.toLowerCase();
    if (blob.includes("login") || blob.includes("not logged in") || blob.includes("authenticat") || blob.includes("/login")) {
      cb.onError(
        new ClaudeCliError(
          "Claude is not logged in. Open a terminal, run `claude`, sign in, then try again.",
          "not_logged_in"
        )
      );
      return;
    }
    // Prefer the model's own error text; add a hint for the common transient cases.
    const detail = (errorInfo || resultText || stderr || "").trim();
    const transient = /overload|rate.?limit|429|529|usage limit|too many/.test(blob);
    const hint = transient ? " — Claude looks rate-limited/overloaded; wait a moment and retry." : "";
    cb.onError(
      new ClaudeCliError(
        `Analysis failed${code != null ? ` (exit ${code})` : ""}: ${detail ? detail.slice(0, 400) : "no output from Claude"}${hint}`,
        "failed"
      )
    );
  });

  // Feed the untrusted content in via stdin, then close it.
  child.stdin.write(stdin);
  child.stdin.end();

  return {
    kill: () => {
      try { child.kill(); } catch { /* ignore */ }
    },
  };
}
