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
 *   free-text question, file names read off disk, anything a third party wrote)
 *   MUST be passed via `spec.stdin`, never interpolated into argv or a shell
 *   string. A repo can legitimately contain a file called
 *   `--dangerously-skip-permissions`; a file name must never become an argv token.
 *
 *   `cwd: "isolated"` spawns the child in a fresh empty temp directory so it
 *   cannot auto-load any repo's CLAUDE.md / settings, and grants no tools.
 *   That is the correct mode for any run that reads untrusted text.
 *
 *   `cwd: {dir}` runs inside a real repo, which DOES load that repo's CLAUDE.md
 *   — verified: neither `--safe-mode` nor a full system-prompt override
 *   suppresses it. That is only safe for runs whose input has already been
 *   schema-validated and sanitized by the app, and whose tool set is clamped
 *   with `tools.set` — never for raw third-party prose.
 *
 *   `tools.set` maps to `--tools`, which removes the omitted tools from the
 *   child's tool SCHEMA rather than merely denying them. That is the strongest
 *   control available: a prompt-injected CLAUDE.md cannot call a tool that does
 *   not exist. `tools.disallowed` is the second layer, and is the only thing
 *   that stops a child from reading `.env` — keep the deny rules.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export type PermissionMode = "dontAsk" | "plan" | "acceptEdits";
export type SettingSource = "user" | "project" | "local";

export interface RunSpec {
  /** Fixed, app-authored `-p` text. Never user content. */
  instruction: string;
  /** Fixed, app-authored `--append-system-prompt` text. Never user content. */
  systemPrompt: string;
  /** ALL untrusted content goes here. */
  stdin: string;
  cwd: "isolated" | { dir: string };
  tools?: {
    /** `--tools`: the child's entire tool schema. The hard limit. */
    set?: string[];
    /** `--allowed-tools`: pre-approved, so `dontAsk` doesn't deny them. */
    allowed?: string[];
    /** `--disallowed-tools`: denied at the permission layer. Supports globs. */
    disallowed?: string[];
  };
  settingSources?: SettingSource[];
  safeMode?: boolean;
  addDirs?: string[];
  permissionMode?: PermissionMode;
  outputFormat?: "stream-json" | "json";
  model?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface RunMeta {
  costUsd?: number;
  totalTokens?: number;
  durationMs?: number;
  resultText?: string;
}

export interface RunCallbacks {
  onChunk: (text: string) => void;
  /** Fires for every tool_use the child emits — use it to audit what was touched. */
  onToolUse?: (t: { name: string; input: unknown }) => void;
  onDone: (meta: RunMeta) => void;
  onError: (err: ClaudeCliError) => void;
}

interface Launcher {
  cmd: string;
  preArgs: string[];
  viaShell: boolean;
}

let LAUNCHER: Launcher | null | undefined;

function resolveClaudeLauncher(): Launcher | null {
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
    // Windows refuses to spawn a .cmd shim with shell:false (EINVAL), so prefer
    // a real .exe, then the packaged exe/cli.js, and only fall back to the shell.
    // shell:false matters for more than quoting: kill() then reaches the real
    // process instead of a cmd.exe wrapper, so aborts don't orphan `claude`.
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

const DEFAULT_TIMEOUT_MS = 120_000;

/** Best-effort extraction of the interesting target from a tool_use input. */
export function toolTarget(input: unknown): string | undefined {
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
export function runClaude(spec: RunSpec, cb: RunCallbacks): { kill: () => void } {
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
    "--no-session-persistence", // don't litter ~/.claude with app-driven runs
  ];

  // --tools clamps the child's tool SCHEMA; the allow/deny lists layer on top.
  if (spec.tools?.set?.length) args.push("--tools", spec.tools.set.join(","));
  if (spec.tools?.allowed?.length) args.push("--allowed-tools", spec.tools.allowed.join(","));
  if (spec.tools?.disallowed?.length)
    args.push("--disallowed-tools", spec.tools.disallowed.join(","));
  if (spec.settingSources) args.push("--setting-sources", spec.settingSources.join(","));
  // Suppresses the target repo's hooks/plugins/skills/MCP — a repo's
  // .claude/settings.json can define hooks, i.e. arbitrary shell commands, which
  // is the one genuine code-execution path through a user-chosen directory.
  if (spec.safeMode) args.push("--safe-mode");
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
        `Run failed${code != null ? ` (exit ${code})` : ""}: ${detail ? detail.slice(0, 400) : "no output from Claude"}${hint}`,
        "failed"
      )
    );
  });

  // Feed the untrusted content in via stdin, then close it. Always write, even
  // when empty — the CLI otherwise warns and stalls ~3s waiting for stdin.
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
