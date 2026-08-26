/**
 * Shared runner for the locally-installed Claude Code CLI.
 *
 * We spawn `claude -p` in headless, streaming mode using the user's existing
 * Claude login (OAuth/subscription) — no API key needed.
 *
 * INJECTION BOUNDARY — this comment governs EVERY caller of runClaude():
 *
 *   The `-p` instruction and the `--append-system-prompt` text are fixed,
 *   app-authored strings. ALL untrusted content (Creatio case text, the user's
 *   free-text question, anything a third party wrote) MUST be passed via
 *   `spec.stdin`, never interpolated into argv or a shell string.
 *
 *   `cwd: "isolated"` spawns the child in a fresh empty temp directory so it
 *   cannot auto-load any repo's CLAUDE.md / settings, and grants no tools.
 *   That is the correct mode for any run that reads untrusted text.
 *
 *   `cwd: {dir}` runs inside a real repo, which DOES load that repo's CLAUDE.md.
 *   That is only safe for runs whose input has already been schema-validated and
 *   sanitized by the app — never for raw third-party prose. See src/triage.ts
 *   for the two-stage split this enables.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// ---------------------------------------------------------------------------
// Locate the claude binary once.
//
// On Windows `where claude` finds the npm .cmd shim, and batch shims re-parse
// their arguments: any arg containing a double quote (e.g. an instruction that
// describes a JSON schema) gets mangled in transit, silently swallowing the
// flags that follow it. So we look through the shim to the real
// bin/claude.exe and spawn THAT with shell:false — argv goes across as an
// array and no quoting layer ever runs. The shell path survives only as a
// last-resort fallback for unrecognized install layouts.
// ---------------------------------------------------------------------------
interface ClaudeLauncher {
  cmd: string;
  preArgs: string[];
  /** True only for the .cmd-via-cmd.exe fallback (args must be quote-free). */
  viaShell: boolean;
}

let LAUNCHER: ClaudeLauncher | null | undefined;

function resolveClaudeLauncher(): ClaudeLauncher | null {
  if (LAUNCHER !== undefined) return LAUNCHER;
  const isWin = process.platform === "win32";
  const finder = isWin ? "where" : "which";
  let lines: string[] = [];
  try {
    const r = spawnSync(finder, ["claude"], { encoding: "utf8" });
    lines = (r.stdout || "")
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    /* fall through to null */
  }

  if (!lines.length) {
    LAUNCHER = null;
  } else if (!isWin) {
    LAUNCHER = { cmd: lines[0], preArgs: [], viaShell: false };
  } else {
    const exeOnPath = lines.find((l) => /\.exe$/i.test(l));
    const cmdShim = lines.find((l) => /\.cmd$/i.test(l));
    const pkgDir = cmdShim
      ? join(dirname(cmdShim), "node_modules", "@anthropic-ai", "claude-code")
      : null;
    const shimExe = pkgDir ? join(pkgDir, "bin", "claude.exe") : null;
    const shimCli = pkgDir ? join(pkgDir, "cli.js") : null;

    if (exeOnPath) {
      LAUNCHER = { cmd: exeOnPath, preArgs: [], viaShell: false };
    } else if (shimExe && existsSync(shimExe)) {
      LAUNCHER = { cmd: shimExe, preArgs: [], viaShell: false };
    } else if (shimCli && existsSync(shimCli)) {
      LAUNCHER = { cmd: process.execPath, preArgs: [shimCli], viaShell: false };
    } else {
      LAUNCHER = { cmd: cmdShim || lines[0], preArgs: [], viaShell: true };
    }
  }
  return LAUNCHER;
}

export function claudeAvailable(): boolean {
  return Boolean(resolveClaudeLauncher());
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
// Spec
// ---------------------------------------------------------------------------
export type PermissionMode = "dontAsk" | "plan" | "acceptEdits";
export type SettingSource = "user" | "project" | "local";

export interface ClaudeRunSpec {
  /** -p argument. App-authored ONLY — never untrusted text. */
  instruction: string;
  /** --append-system-prompt. App-authored ONLY. */
  systemPrompt: string;
  /** Everything untrusted goes here. Written to the child's stdin. */
  stdin: string;
  /** "isolated" => fresh empty mkdtemp (no CLAUDE.md, no tools by default). */
  cwd: "isolated" | { dir: string };
  tools?: { allowed?: string[]; disallowed?: string[] };
  permissionMode?: PermissionMode;
  /** Omit entirely to inherit CLI defaults; pass [] to load no settings files. */
  settingSources?: SettingSource[];
  addDirs?: string[];
  model?: string;
  /** Emit one final JSON result instead of streaming deltas. */
  outputFormat?: "stream-json" | "json";
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface RunMeta {
  costUsd?: number;
  totalTokens?: number;
  durationMs?: number;
}

export interface ClaudeRunCallbacks {
  onChunk: (text: string) => void;
  /** Fires per tool_use block seen in the stream — drives the audit log + UI. */
  onToolUse?: (t: { name: string; input: unknown }) => void;
  onDone: (meta: RunMeta & { resultText: string }) => void;
  onError: (err: ClaudeCliError) => void;
}

const DEFAULT_TIMEOUT_MS = 120_000;

/** Best-effort extraction of the interesting target from a tool_use input. */
function toolTarget(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const o = input as Record<string, unknown>;
  for (const k of ["file_path", "path", "pattern", "command", "url"]) {
    const v = o[k];
    if (typeof v === "string" && v) return v;
  }
  return undefined;
}

/**
 * Run the Claude CLI, streaming text chunks via callbacks. Never rejects — all
 * outcomes are delivered through onDone / onError.
 */
export function runClaude(spec: ClaudeRunSpec, cb: ClaudeRunCallbacks): { kill: () => void } {
  const launcher = resolveClaudeLauncher();
  if (!launcher) {
    cb.onError(
      new ClaudeCliError(
        "The Claude CLI was not found. Install it (npm i -g @anthropic-ai/claude-code) and run `claude` once to log in.",
        "not_installed"
      )
    );
    return { kill: () => {} };
  }

  const outputFormat = spec.outputFormat || "stream-json";
  const args = [
    "-p",
    spec.instruction,
    "--output-format",
    outputFormat,
    "--verbose",
    // Partial text deltas exist only in stream-json mode; the flag errors otherwise.
    ...(outputFormat === "stream-json" ? ["--include-partial-messages"] : []),
    "--strict-mcp-config", // no --mcp-config => all MCP servers disabled
    "--permission-mode",
    spec.permissionMode || "dontAsk", // never blocks on an interactive prompt
    "--append-system-prompt",
    spec.systemPrompt,
  ];
  if (spec.tools?.allowed?.length) args.push("--allowed-tools", spec.tools.allowed.join(","));
  if (spec.tools?.disallowed?.length)
    args.push("--disallowed-tools", spec.tools.disallowed.join(","));
  if (spec.settingSources) args.push("--setting-sources", spec.settingSources.join(","));
  for (const d of spec.addDirs || []) args.push("--add-dir", d);
  if (spec.model) args.push("--model", spec.model);

  let cwd: string;
  if (spec.cwd === "isolated") {
    try {
      cwd = mkdtempSync(join(tmpdir(), "creatio-run-"));
    } catch {
      cwd = tmpdir();
    }
  } else {
    cwd = spec.cwd.dir;
  }

  // Prefer shell:false everywhere — argv crosses as an array, no quoting layer,
  // so instructions containing quotes survive intact. The shell path is only
  // the last-resort .cmd fallback (see resolveClaudeLauncher); it stays
  // injection-safe because EVERY arg here is app-authored and individually
  // quoted, and all untrusted content is on stdin, never on the command line.
  const argv = [...launcher.preArgs, ...args];
  const child = launcher.viaShell
    ? spawn([launcher.cmd, ...argv].map(winQuote).join(" "), {
        cwd,
        shell: true,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
        signal: spec.signal,
      })
    : spawn(launcher.cmd, argv, {
        cwd,
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
        signal: spec.signal,
      });

  let stderr = "";
  let buffer = "";
  let rawAll = ""; // full stdout — needed for --output-format json (see close)
  let finished = false;
  const meta: RunMeta = {};
  let streamedAny = false; // did we get any streamed text deltas?
  let resultText = ""; // final `result` text (fallback if deltas didn't stream)
  let isError = false; // Claude reported an error result
  let errorInfo = ""; // subtype / api_error_status for a clearer message

  const timer = setTimeout(() => {
    if (!finished) {
      finished = true;
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      const secs = Math.round((spec.timeoutMs || DEFAULT_TIMEOUT_MS) / 1000);
      cb.onError(new ClaudeCliError(`The run timed out after ${secs}s.`, "failed"));
    }
  }, spec.timeoutMs || DEFAULT_TIMEOUT_MS);

  function handleLine(line: string): void {
    const s = line.trim();
    if (!s) return;
    let obj: any;
    try {
      obj = JSON.parse(s);
    } catch {
      return; // ignore non-JSON noise
    }
    handleObj(obj);
  }

  function handleObj(obj: any): void {
    if (obj.type === "stream_event") {
      const ev = obj.event;
      if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta") {
        streamedAny = true;
        cb.onChunk(ev.delta.text || "");
      }
    } else if (obj.type === "assistant" && cb.onToolUse) {
      // Surface tool calls so callers can audit / display what was touched.
      const content = obj.message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block?.type === "tool_use" && typeof block.name === "string") {
            cb.onToolUse({ name: block.name, input: block.input });
          }
        }
      }
    } else if (obj.type === "result") {
      if (typeof obj.result === "string") resultText = obj.result;
      if (obj.is_error) isError = true;
      if (obj.subtype && obj.subtype !== "success") errorInfo = String(obj.subtype);
      if (obj.api_error_status) errorInfo = `API ${obj.api_error_status}`;
      if (obj.error)
        errorInfo =
          typeof obj.error === "string" ? obj.error : JSON.stringify(obj.error).slice(0, 200);
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
    rawAll += d;
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

    // --output-format json emits ONE JSON document (an array of messages, or a
    // bare result object) rather than line-delimited events — the line parser
    // above sees an array, finds no .type, and extracts nothing. Re-parse the
    // whole capture and walk it.
    if (spec.outputFormat === "json" && !resultText) {
      try {
        const doc = JSON.parse(rawAll.trim());
        for (const item of Array.isArray(doc) ? doc : [doc]) handleObj(item);
      } catch {
        /* fall through to the normal error paths */
      }
    }

    // Some runs deliver the whole answer in the final `result` line rather than
    // as streamed deltas — surface it so the panel isn't blank.
    if (!streamedAny && resultText && !isError) cb.onChunk(resultText);

    if (code === 0 && !isError) {
      cb.onDone({ ...meta, resultText });
      return;
    }

    const blob = `${stderr} ${errorInfo} ${resultText}`.toLowerCase();
    if (
      blob.includes("login") ||
      blob.includes("not logged in") ||
      blob.includes("authenticat") ||
      blob.includes("/login")
    ) {
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
    const hint = transient
      ? " — Claude looks rate-limited/overloaded; wait a moment and retry."
      : "";
    cb.onError(
      new ClaudeCliError(
        `Run failed${code != null ? ` (exit ${code})` : ""}: ${
          detail ? detail.slice(0, 400) : "no output from Claude"
        }${hint}`,
        "failed"
      )
    );
  });

  // Feed the untrusted content in via stdin, then close it.
  child.stdin.write(spec.stdin);
  child.stdin.end();

  return {
    kill: () => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
    },
  };
}

export { toolTarget };
