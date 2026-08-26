/**
 * Deterministic index over the custom-reports tree.
 *
 * Two jobs:
 *   1. Give the triage agent a bounded, trusted list of real files to choose
 *      from, so it never has to walk ~7,000 district directories.
 *   2. Provide O(1) validation of any path a model hands back. Model output is
 *      NEVER trusted as a path source — every candidate is re-checked against
 *      `allFiles` before it is shown to the user or acted on.
 *
 * Nothing here writes into custom-reports. The disk cache lives under this
 * tool's own directory, because every subrepo auto-deploys on push and a stray
 * file inside one could be swept into a release.
 */

import { readdir, mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve, sep } from "node:path";

export const REPO_ROOT =
  process.env.CUSTOM_REPORTS_ROOT || "C:\\neldevsrc\\custom-reports";

const TOOL_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const CACHE_DIR = join(TOOL_DIR, ".cache");
const CACHE_FILE = join(CACHE_DIR, "repo-index.json");
const TTL_MS = 10 * 60 * 1000;

/** The ten independent git repos under custom-reports. */
export const SUBREPOS = [
  "ReportCardAO",
  "ReportCardPZ",
  "ReportCardRoot",
  "Transcripts",
  "ProgressReport",
  "ReportsCustomDL",
  "ReportsCustomMR",
  "ReportsCustomSZ",
  "ReportModules",
  "Modules",
] as const;
export type SubRepo = (typeof SUBREPOS)[number];

/** Extensions worth indexing — templates, includes, and their assets. */
const CODE_EXT = new Set([".cfm", ".cfc", ".htm", ".html", ".css", ".js", ".md", ".xlsx", ".csv"]);

/** Directories that are never districts / never worth walking. */
const SKIP_DIR = new Set([
  ".git",
  ".vscode",
  ".svn",
  "node_modules",
  "_notes",
  "_mmServerScripts",
  "__MACOSX",
]);

/**
 * The canonical district-code shape: AA-CA, HCA-CAN, SA-GUAM, RWI-JAMAICA.
 *
 * This is a *quality* signal, not a gate. Roughly 600 real folders don't match
 * it — JAMAICA, BrooklynDioc, CCA, CH-Longview — and cases are filed against
 * them like any other. Gating the index on this shape made those folders
 * invisible to triage: unofferable as candidates and unreachable as edit scope.
 * Every top-level folder is indexed now; `strict` just records which ones look
 * like a real code so name-based scoring can prefer them.
 */
const DISTRICT_CODE_RE = /^[A-Za-z][A-Za-z0-9]{1,7}(-[A-Za-z0-9]{2,8})+$/;

/** Build artifacts and scratch folders — never a district, never worth offering. */
const JUNK_DIR_RE = /^(?:_|tmp-|copy of )|_files$/i;

export interface DistrictEntry {
  subrepo: SubRepo;
  code: string; // as it appears on disk, e.g. "HCA-CAN"
  relDir: string; // "ReportCardAO/HCA-CAN"
  files: string[]; // repo-relative, forward-slash
  /** True when `code` matches the canonical district-code shape. */
  strict: boolean;
}

export interface RepoIndex {
  builtAt: number;
  /** UPPERCASE code -> entries. A code can exist in several subrepos. */
  districts: Map<string, DistrictEntry[]>;
  /** Lowercased repo-relative paths, for O(1) case-insensitive validation. */
  allFiles: Set<string>;
  /** Canonical (on-disk case) path keyed by lowercased path. */
  canonical: Map<string, string>;
  /**
   * Lowercased basename -> canonical paths carrying it. Lets us resolve a
   * filename a case mentions ("TermReportCardLog.cfm") back to real files
   * without trusting the model to know where it lives. ~94% of basenames in
   * this tree are unique, so this resolves cleanly far more often than not.
   */
  byBasename: Map<string, string[]>;
  /** ReportCardRoot/* — the shared generic includes. */
  rootFiles: string[];
  counts: Record<string, number>;
}

let cached: RepoIndex | null = null;

function toPosix(p: string): string {
  return p.split(sep).join("/").replace(/\\/g, "/");
}

/** Recursively list files under `abs`, returning repo-relative posix paths. */
async function walk(abs: string, rel: string, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(abs, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (SKIP_DIR.has(e.name)) continue;
      await walk(join(abs, e.name), `${rel}/${e.name}`, out);
    } else if (e.isFile()) {
      const dot = e.name.lastIndexOf(".");
      const ext = dot === -1 ? "" : e.name.slice(dot).toLowerCase();
      if (CODE_EXT.has(ext)) out.push(`${rel}/${e.name}`);
    }
  }
}

export interface BuildProgress {
  (msg: string): void;
}

export async function buildIndex(force = false, onProgress?: BuildProgress): Promise<RepoIndex> {
  if (!force && cached && Date.now() - cached.builtAt < TTL_MS) return cached;
  if (!force) {
    const disk = await loadCache();
    if (disk) {
      cached = disk;
      return disk;
    }
  }

  const districts = new Map<string, DistrictEntry[]>();
  const allFiles = new Set<string>();
  const canonical = new Map<string, string>();
  const byBasename = new Map<string, string[]>();
  const rootFiles: string[] = [];
  const counts: Record<string, number> = {};

  const addFile = (rel: string): void => {
    const lower = rel.toLowerCase();
    allFiles.add(lower);
    canonical.set(lower, rel);
    const base = lower.slice(lower.lastIndexOf("/") + 1);
    const bucket = byBasename.get(base);
    if (bucket) bucket.push(rel);
    else byBasename.set(base, [rel]);
  };

  for (const sub of SUBREPOS) {
    const subAbs = join(REPO_ROOT, sub);
    let top;
    try {
      top = await readdir(subAbs, { withFileTypes: true });
    } catch {
      counts[sub] = 0;
      continue; // subrepo not present on this machine
    }
    onProgress?.(`Indexing ${sub}…`);

    let n = 0;
    for (const e of top) {
      if (e.isFile()) {
        const dot = e.name.lastIndexOf(".");
        const ext = dot === -1 ? "" : e.name.slice(dot).toLowerCase();
        if (!CODE_EXT.has(ext)) continue;
        const rel = `${sub}/${e.name}`;
        addFile(rel);
        if (sub === "ReportCardRoot") rootFiles.push(rel);
        n++;
        continue;
      }
      if (!e.isDirectory() || SKIP_DIR.has(e.name)) continue;

      const files: string[] = [];
      await walk(join(subAbs, e.name), `${sub}/${e.name}`, files);
      for (const f of files) addFile(f);
      n += files.length;

      // Every folder that holds code is addressable, code-shaped name or not.
      if (files.length && !JUNK_DIR_RE.test(e.name)) {
        const key = e.name.toUpperCase();
        const entry: DistrictEntry = {
          subrepo: sub,
          code: e.name,
          relDir: `${sub}/${e.name}`,
          files,
          strict: DISTRICT_CODE_RE.test(e.name),
        };
        const list = districts.get(key);
        if (list) list.push(entry);
        else districts.set(key, [entry]);
      }
    }
    counts[sub] = n;
  }

  const ix: RepoIndex = {
    builtAt: Date.now(),
    districts,
    allFiles,
    canonical,
    byBasename,
    rootFiles,
    counts,
  };
  cached = ix;
  await saveCache(ix).catch(() => {
    /* cache is an optimization; never fatal */
  });
  return ix;
}

// ---------------------------------------------------------------------------
// Validation helpers — the load-bearing controls
// ---------------------------------------------------------------------------

/** True if `relPath` names a real indexed file (case-insensitive). */
export function isKnownFile(ix: RepoIndex, relPath: string): boolean {
  return ix.allFiles.has(normalizeRel(relPath).toLowerCase());
}

/** Canonical on-disk casing for a known path, or null. */
export function canonicalPath(ix: RepoIndex, relPath: string): string | null {
  return ix.canonical.get(normalizeRel(relPath).toLowerCase()) ?? null;
}

/** Normalize a model- or user-supplied relative path to posix, no leading slash. */
export function normalizeRel(p: string): string {
  return toPosix(String(p || "").trim())
    .replace(/^\.\//, "")
    .replace(/^\/+/, "")
    .replace(/\/+/g, "/");
}

/**
 * Resolve a repo-relative path to an absolute one, refusing traversal and
 * absolute input. Returns null if the result would escape REPO_ROOT.
 */
export function toAbs(relPath: string): string | null {
  const raw = toPosix(String(relPath || "").trim());
  // Refuse absolute input outright rather than silently making it relative.
  if (raw.startsWith("/") || /^[A-Za-z]:/.test(raw)) return null;
  const rel = normalizeRel(raw);
  if (!rel || rel.includes("..")) return null;
  // Must name a real subrepo — nothing else is addressable.
  if (!subrepoOf(rel)) return null;
  const abs = resolve(REPO_ROOT, rel);
  const rootWithSep = resolve(REPO_ROOT) + sep;
  if (!abs.startsWith(rootWithSep)) return null;
  return abs;
}

/** Which subrepo does this path belong to? */
export function subrepoOf(relPath: string): SubRepo | null {
  const head = normalizeRel(relPath).split("/")[0];
  return (SUBREPOS as readonly string[]).includes(head) ? (head as SubRepo) : null;
}

/**
 * The district folder a repo-relative file lives in, or null for a file that
 * sits directly in a subrepo root (ReportCardRoot includes, mostly).
 */
export function districtForPath(ix: RepoIndex, relPath: string): DistrictEntry | null {
  const parts = normalizeRel(relPath).split("/");
  if (parts.length < 3) return null;
  const relDir = `${parts[0]}/${parts[1]}`;
  for (const e of ix.districts.get(parts[1].toUpperCase()) || []) {
    if (e.relDir.toLowerCase() === relDir.toLowerCase()) return e;
  }
  return null;
}

/** Districts whose code contains `needle` (case-insensitive). */
export function districtsMatching(ix: RepoIndex, needle: string): DistrictEntry[] {
  const n = needle.trim().toUpperCase();
  if (!n) return [];
  const out: DistrictEntry[] = [];
  for (const [code, entries] of ix.districts) {
    if (code.includes(n)) out.push(...entries);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Disk cache
// ---------------------------------------------------------------------------
/** Bump when the index shape or the folder-selection rules change. */
const CACHE_VERSION = 2;

interface CacheShape {
  version: number;
  builtAt: number;
  districts: Array<[string, DistrictEntry[]]>;
  rootFiles: string[];
  counts: Record<string, number>;
  files: string[]; // canonical casing
}

async function saveCache(ix: RepoIndex): Promise<void> {
  await mkdir(CACHE_DIR, { recursive: true });
  const shape: CacheShape = {
    version: CACHE_VERSION,
    builtAt: ix.builtAt,
    districts: [...ix.districts.entries()],
    rootFiles: ix.rootFiles,
    counts: ix.counts,
    files: [...ix.canonical.values()],
  };
  await writeFile(CACHE_FILE, JSON.stringify(shape), "utf8");
}

async function loadCache(): Promise<RepoIndex | null> {
  try {
    const raw = await readFile(CACHE_FILE, "utf8");
    const shape = JSON.parse(raw) as CacheShape;
    if (shape?.version !== CACHE_VERSION) return null; // stale layout — rebuild
    if (!shape?.builtAt || Date.now() - shape.builtAt > TTL_MS) return null;
    const allFiles = new Set<string>();
    const canonical = new Map<string, string>();
    const byBasename = new Map<string, string[]>();
    for (const f of shape.files) {
      const lower = f.toLowerCase();
      allFiles.add(lower);
      canonical.set(lower, f);
      const base = lower.slice(lower.lastIndexOf("/") + 1);
      const bucket = byBasename.get(base);
      if (bucket) bucket.push(f);
      else byBasename.set(base, [f]);
    }
    return {
      builtAt: shape.builtAt,
      districts: new Map(shape.districts),
      allFiles,
      canonical,
      byBasename,
      rootFiles: shape.rootFiles,
      counts: shape.counts,
    };
  } catch {
    return null;
  }
}
