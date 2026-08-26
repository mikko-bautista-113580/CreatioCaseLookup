/**
 * Durable store for hand-made case fixes ("Record my fix").
 *
 * Some cases the developer fixes by hand in custom-reports instead of letting
 * the AI worker touch them. This module captures those: it scans the working
 * tree for uncommitted changes (reusing workOn's git accounting) and persists
 * the developer-selected subset — file list + diffs + a typed note — keyed by
 * case number, so past fixes survive restarts and can be browsed later.
 *
 * Pure storage + scan: no Creatio, no repo index, no audit calls in here.
 * District derivation and auditing are the server handlers' business.
 */

import { randomUUID } from "node:crypto";
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { SUBREPOS } from "./repoIndex.js";
import { collectChanges, type FileChange, type GitBaseline } from "./workOn.js";

const TOOL_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const STATE_DIR = join(TOOL_DIR, ".state");
const FIX_FILE = join(STATE_DIR, "fixes.json");
const STORE_VERSION = 1;

export interface FixRecord {
  id: string;
  caseNumber: string;
  subject?: string;
  note: string;
  createdAt: string; // ISO
  /** District codes derived from the file paths, best-effort. */
  districts: string[];
  files: FileChange[];
}

interface StoreShape {
  v: number;
  fixes: FixRecord[]; // newest first
}

// ---------------------------------------------------------------------------
// Scan — every uncommitted change across all subrepos
// ---------------------------------------------------------------------------

/**
 * All current uncommitted changes in the custom-reports tree. An empty
 * baseline makes collectChanges report the entire dirty state; a missing
 * subrepo simply yields no changes (runGit never throws).
 */
export async function scanWorkingChanges(): Promise<FileChange[]> {
  const baseline: GitBaseline = new Map(SUBREPOS.map((s) => [s, new Set<string>()]));
  const { changes } = await collectChanges(baseline);
  return changes;
}

// ---------------------------------------------------------------------------
// Persistence — versioned JSON, atomic writes, corruption never clobbered
// ---------------------------------------------------------------------------

async function writeAtomic(abs: string, text: string): Promise<void> {
  await mkdir(STATE_DIR, { recursive: true });
  const tmp = `${abs}.tmp-${process.pid}`;
  await writeFile(tmp, text, "utf8");
  await rename(tmp, abs);
}

/** Move a bad store aside so a later save can't destroy recoverable data. */
async function quarantine(): Promise<void> {
  try {
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    await rename(FIX_FILE, join(STATE_DIR, `fixes.corrupt-${ts}.json`));
  } catch {
    /* best-effort */
  }
}

export async function loadFixes(): Promise<FixRecord[]> {
  let raw: string;
  try {
    raw = await readFile(FIX_FILE, "utf8");
  } catch {
    return []; // no store yet
  }
  try {
    const shape = JSON.parse(raw) as StoreShape;
    if (shape.v !== STORE_VERSION || !Array.isArray(shape.fixes)) {
      await quarantine();
      return [];
    }
    return shape.fixes;
  } catch {
    await quarantine();
    return [];
  }
}

// Read-modify-write cycles queue behind each other so two rapid saves (or a
// save racing a delete) can never lose a record.
let queue: Promise<unknown> = Promise.resolve();

function enqueue<T>(job: () => Promise<T>): Promise<T> {
  const next = queue.then(job, job);
  queue = next.catch(() => {});
  return next;
}

export function saveFix(rec: Omit<FixRecord, "id" | "createdAt">): Promise<FixRecord> {
  return enqueue(async () => {
    const fix: FixRecord = { ...rec, id: randomUUID(), createdAt: new Date().toISOString() };
    const fixes = await loadFixes();
    fixes.unshift(fix);
    await writeAtomic(FIX_FILE, JSON.stringify({ v: STORE_VERSION, fixes } satisfies StoreShape));
    return fix;
  });
}

export function deleteFix(id: string): Promise<FixRecord | null> {
  return enqueue(async () => {
    const fixes = await loadFixes();
    const i = fixes.findIndex((f) => f.id === id);
    if (i === -1) return null;
    const [removed] = fixes.splice(i, 1);
    await writeAtomic(FIX_FILE, JSON.stringify({ v: STORE_VERSION, fixes } satisfies StoreShape));
    return removed;
  });
}
