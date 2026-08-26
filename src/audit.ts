/**
 * Append-only NDJSON audit log.
 *
 * The tool previously kept no record of anything. Once an agent is reading
 * third-party case text and proposing edits to templates that auto-deploy, a
 * durable trail of "what ran, what it touched, what we rejected, what a human
 * approved" stops being optional.
 *
 * `paths.rejected` is the injection canary: if case text ever steers the model
 * toward a path outside the candidate set, validation drops it and it lands
 * here. A run with rejected paths deserves a look.
 *
 * Writes are synchronous appends and never throw — auditing must not be able to
 * break the request it is recording.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

const AUDIT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", ".audit");

export type Stage = "triage" | "investigate" | "plan" | "fix";

export type AuditEvent =
  | { t: "run.start"; runId: string; stage: Stage; caseNumber: string }
  | {
      t: "run.end";
      runId: string;
      ok: boolean;
      durationMs?: number;
      costUsd?: number;
      tokens?: number;
      error?: string;
    }
  | { t: "tool"; runId: string; name: string; target?: string }
  | { t: "brief"; runId: string; caseNumber: string; brief: unknown }
  | { t: "paths.rejected"; runId: string; caseNumber: string; paths: string[]; reason: string }
  | { t: "worktree"; runId: string; action: "create" | "remove"; dir: string; branch: string }
  | { t: "patch"; runId: string; files: string[]; bytes: number }
  | {
      t: "human";
      runId: string;
      action: "approve" | "reject" | "discard";
      stage: Stage;
      /** Set when the approval was for ONE file of a plan, not the whole plan. */
      only?: string;
    }
  | { t: "attachments"; caseNumber: string; count: number; images: number; notes: string[] }
  | {
      // A developer-approved copy of a staged attachment into the repo.
      t: "place";
      caseNumber: string;
      from: string;
      to: string;
      bytes: number;
      replaced: boolean;
    }
  // A hand-made fix the developer recorded against a case (no agent run).
  | { t: "fix.save"; id: string; caseNumber: string; files: string[]; bytes: number }
  | { t: "fix.delete"; id: string; caseNumber: string }
  // Free-text guidance the developer typed for a run. Trusted input, so it is
  // recorded verbatim: it changes what the agent did and belongs in the trail.
  | { t: "hint"; runId: string; caseNumber: string; stage: Stage; text: string };

let ensured = false;

function ensureDir(): void {
  if (ensured) return;
  try {
    mkdirSync(AUDIT_DIR, { recursive: true });
    ensured = true;
  } catch {
    /* ignore — audit() will swallow the write failure too */
  }
}

function fileForToday(): string {
  const d = new Date();
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate()
  ).padStart(2, "0")}`;
  return join(AUDIT_DIR, `${day}.ndjson`);
}

/** Append one event. Never throws. */
export function audit(e: AuditEvent): void {
  try {
    ensureDir();
    const line = JSON.stringify({ ts: new Date().toISOString(), ...e });
    appendFileSync(fileForToday(), line + "\n", "utf8");
  } catch {
    /* auditing must never break the caller */
  }
  // Mirror to stderr so the console stays useful during a run.
  try {
    const tag = `[pipeline:${e.t}]`;
    if (e.t === "paths.rejected") {
      console.error(`${tag} ${e.caseNumber} dropped ${e.paths.length}: ${e.reason}`);
    } else if (e.t === "run.start") {
      console.error(`${tag} ${e.stage} ${e.caseNumber} (${e.runId})`);
    } else if (e.t === "run.end") {
      console.error(`${tag} ${e.runId} ok=${e.ok}${e.error ? ` err=${e.error.slice(0, 120)}` : ""}`);
    } else if (e.t === "tool") {
      console.error(`${tag} ${e.name}${e.target ? ` ${e.target}` : ""}`);
    }
  } catch {
    /* ignore */
  }
}

export function newRunId(): string {
  return randomUUID().slice(0, 8);
}
