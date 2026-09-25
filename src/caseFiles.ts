/**
 * Find the workspace files related to one case — quickly, and without a model.
 *
 * The whole-folder analysis reads every top-level file whatever the case is.
 * A case-scoped analysis instead reads only what this module ranks as related:
 *
 *   1. walk the folders RECURSIVELY (school-code folders sit under the root),
 *      bounded by depth, file count and a time budget;
 *   2. score each file by its path (a school-code folder or a file named in the
 *      case is the strongest signal there is) and by how often its content
 *      mentions the case terms;
 *   3. follow ONE hop of `<cfinclude template>` / `<cfmodule template>` from
 *      the best hits, because a report template's bug often lives in the
 *      include it pulls in;
 *   4. keep the top `fileCap()`.
 *
 * Every file carries a `rel` path produced by this walk. Nothing downstream
 * ever joins a model- or user-supplied string onto a folder: edits are matched
 * against this census by (folder, rel), exactly as the top-level census works.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, isAbsolute, join, posix } from "node:path";

import type { CaseTerm } from "./caseKeywords.js";
import { idf } from "./wikiSelect.js";
import {
  isTextFile,
  MAX_FILE_BYTES,
  SECRET_RE,
  SKIP_DIRS,
  type AnalysisMeta,
  type CaseSelection,
  type MultiEnumResult,
  type WorkspaceFile,
} from "./workspace.js";

const MAX_DEPTH = 5;
const MAX_FILES = 5000;
const WALK_BUDGET_MS = 3000;
const READ_BUDGET_MS = 3000;
const READ_BUDGET_BYTES = 60 * 1024 * 1024;
/** How many top hits have their includes followed. */
const INCLUDE_SOURCES = 5;
/** Drop files scoring under this fraction of the best match. */
const RELATIVE_FLOOR = 0.25;

export interface DeepFile {
  /** Forward-slash path relative to `folder`. */
  rel: string;
  folder: string;
  size: number;
  mtime: string;
  ext: string;
}

export interface DeepEnum {
  files: DeepFile[];
  /** The walk stopped early (depth, count or time) — the view is partial. */
  truncated: boolean;
}

/** Recursive, bounded census of the text/source files under each folder. */
export function enumerateDeep(
  dirs: string[],
  opts: {
    maxDepth?: number;
    maxFiles?: number;
    budgetMs?: number;
    /**
     * Directory names (lowercase) to walk FIRST — a case's school codes. A
     * reports root can hold thousands of school folders; without this, the
     * file limit is spent on folders alphabetically before the right one.
     */
    prefer?: string[];
  } = {}
): DeepEnum {
  const maxDepth = opts.maxDepth ?? MAX_DEPTH;
  const maxFiles = opts.maxFiles ?? MAX_FILES;
  const deadline = Date.now() + (opts.budgetMs ?? WALK_BUDGET_MS);
  const files: DeepFile[] = [];
  let truncated = false;
  const prefer = new Set((opts.prefer || []).map((p) => p.toLowerCase()));

  for (const root of dirs) {
    const queue: { abs: string; rel: string; depth: number }[] = [{ abs: root, rel: "", depth: 0 }];
    while (queue.length) {
      if (files.length >= maxFiles || Date.now() > deadline) {
        truncated = true;
        break;
      }
      const { abs, rel, depth } = queue.shift()!;
      let entries: import("node:fs").Dirent[];
      try {
        entries = readdirSync(abs, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        const name = e.name;
        const childRel = rel ? `${rel}/${name}` : name;
        if (e.isDirectory()) {
          if (SKIP_DIRS.has(name.toLowerCase()) || name.startsWith(".")) continue;
          if (depth + 1 > maxDepth) {
            truncated = true;
            continue;
          }
          const next = { abs: join(abs, name), rel: childRel, depth: depth + 1 };
          if (prefer.has(name.toLowerCase())) queue.unshift(next);
          else queue.push(next);
          continue;
        }
        if (!e.isFile()) continue;
        if (SECRET_RE.test(name) || !isTextFile(name)) continue;
        let st: import("node:fs").Stats;
        try {
          st = statSync(join(abs, name));
        } catch {
          continue;
        }
        if (st.size > MAX_FILE_BYTES) continue;
        files.push({
          rel: childRel,
          folder: root,
          size: st.size,
          mtime: st.mtime.toISOString(),
          ext: extname(name).toLowerCase(),
        });
        if (files.length >= maxFiles) {
          truncated = true;
          break;
        }
      }
    }
  }
  return { files, truncated };
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function countHits(hay: string, term: string): number {
  const re = new RegExp(`(^|[^a-z0-9])${escapeRe(term)}(?=$|[^a-z0-9])`, "g");
  return (hay.match(re) || []).length;
}

/** Does the term appear in the path, either word-bounded or squashed together ("reportcard")? */
function pathMatch(pathLower: string, compact: string, term: string): boolean {
  if (countHits(pathLower, term)) return true;
  const tc = term.replace(/[^a-z0-9]/g, "");
  return tc.length >= 4 && compact.includes(tc);
}

/** `<cfinclude template="…">` and `<cfmodule template="…">` targets. Exported for tests. */
export function includeTargets(content: string): string[] {
  const out: string[] = [];
  for (const m of content.matchAll(/<cf(?:include|module)\b[^>]*\btemplate\s*=\s*["']([^"']+)["']/gi)) {
    const t = m[1].trim();
    // A dynamic path (#var#) can't be resolved statically.
    if (t && !t.includes("#")) out.push(t);
  }
  return out;
}

export interface RankedFile extends DeepFile {
  score: number;
  reason: string;
}

/**
 * Rank the census against the case terms and keep the top `cap`.
 * `readFile` is a test seam; it defaults to reading from disk.
 */
export function rankCaseFiles(
  deep: DeepFile[],
  terms: CaseTerm[],
  cap: number,
  readFile: (f: DeepFile) => string = (f) => readFileSync(join(f.folder, f.rel), "utf8")
): RankedFile[] {
  if (!terms.length || !deep.length) return [];

  // Pass 1 — path matches, recorded per term so they can be weighted by how
  // distinctive each term turns out to be across the whole census.
  const scored = deep.map((f) => {
    const pathLower = f.rel.toLowerCase();
    const compact = pathLower.replace(/[^a-z0-9]/g, "");
    const segs = pathLower.split("/");
    const pathHits: { t: CaseTerm; boost: number; label: string }[] = [];
    for (const t of terms) {
      if (!pathMatch(pathLower, compact, t.term)) continue;
      // A school code naming the FOLDER is the strongest pointer we have.
      const folderHit = t.kind === "code" && segs.slice(0, -1).some((s) => s === t.term);
      const fileHit = t.kind === "file" && basename(pathLower) === t.term;
      pathHits.push({
        t,
        boost: folderHit || fileHit ? 3 : 1,
        label: fileHit ? `named in the case` : folderHit ? `in the ${t.term.toUpperCase()} folder` : `path matches "${t.term}"`,
      });
    }
    return { ...f, pathHits, contentHits: [] as { t: CaseTerm; n: number }[], read: false };
  });

  // Pass 2 — content. Read the most promising files first, so running out of
  // budget drops the least likely ones.
  const order = [...scored].sort(
    (a, b) => b.pathHits.reduce((s, h) => s + h.t.weight * h.boost, 0) - a.pathHits.reduce((s, h) => s + h.t.weight * h.boost, 0)
  );
  const deadline = Date.now() + READ_BUDGET_MS;
  let bytes = 0;
  for (const f of order) {
    if (Date.now() > deadline || bytes > READ_BUDGET_BYTES) break;
    let text: string;
    try {
      text = readFile(f);
    } catch {
      continue;
    }
    f.read = true;
    bytes += text.length;
    const hay = text.toLowerCase();
    for (const t of terms) {
      const n = countHits(hay, t.term);
      if (n) f.contentHits.push({ t, n });
    }
  }

  // Document frequencies → how distinctive each term is.
  const nAll = scored.length;
  const nRead = scored.filter((f) => f.read).length || 1;
  const pathIdf = new Map(terms.map((t) => [t.term, idf(scored.filter((f) => f.pathHits.some((h) => h.t === t)).length, nAll)]));
  const contentIdf = new Map(terms.map((t) => [t.term, idf(scored.filter((f) => f.contentHits.some((h) => h.t === t)).length, nRead)]));

  const ranked = scored
    .map((f) => {
      let score = 0;
      const why: string[] = [];
      for (const h of f.pathHits) {
        score += 2 * h.t.weight * h.boost * (pathIdf.get(h.t.term) ?? 1);
        why.push(h.label);
      }
      const mentioned: string[] = [];
      for (const h of f.contentHits) {
        score += h.t.weight * Math.min(3, Math.log2(1 + h.n)) * (contentIdf.get(h.t.term) ?? 1);
        mentioned.push(h.n > 1 ? `"${h.t.term}"×${h.n}` : `"${h.t.term}"`);
      }
      if (mentioned.length) why.push(`mentions ${mentioned.slice(0, 3).join(", ")}`);
      return { ...f, why, score: Math.round(score * 10) / 10 };
    })
    .filter((f) => f.score > 0)
    .sort((a, b) => b.score - a.score || a.rel.localeCompare(b.rel));

  // One include hop from the best hits.
  const byKey = new Map(deep.map((f) => [`${f.folder.toLowerCase()}|${f.rel.toLowerCase()}`, f]));
  const extra = new Map<string, RankedFile>();
  for (const src of ranked.slice(0, INCLUDE_SOURCES)) {
    let text: string;
    try {
      text = readFile(src);
    } catch {
      continue;
    }
    const dir = posix.dirname(src.rel);
    for (const t of includeTargets(text)) {
      const norm = t.replace(/\\/g, "/");
      const rel = norm.startsWith("/") ? norm.replace(/^\/+/, "") : posix.normalize(posix.join(dir === "." ? "" : dir, norm));
      if (rel.startsWith("..")) continue;
      const hit = byKey.get(`${src.folder.toLowerCase()}|${rel.toLowerCase()}`);
      if (!hit) continue;
      const key = `${hit.folder}|${hit.rel}`;
      if (ranked.some((r) => `${r.folder}|${r.rel}` === key && r.score >= src.score * 0.5)) continue;
      if (!extra.has(key)) {
        extra.set(key, { ...hit, score: Math.round(src.score * 5) / 10, reason: `included by ${src.rel}` });
      }
    }
  }

  const merged = new Map<string, RankedFile>();
  for (const r of ranked) {
    merged.set(`${r.folder}|${r.rel}`, {
      rel: r.rel, folder: r.folder, size: r.size, mtime: r.mtime, ext: r.ext,
      score: r.score,
      reason: r.why.join(" · ") || "matched the case terms",
    });
  }
  for (const [k, e] of extra) {
    const cur = merged.get(k);
    if (!cur || cur.score < e.score) merged.set(k, cur ? { ...cur, score: e.score, reason: `${cur.reason} · ${e.reason}` } : e);
  }
  const out = [...merged.values()].sort((a, b) => b.score - a.score || a.rel.localeCompare(b.rel));
  // Fewer, right files beat a full list: once the school's own folder has
  // been found, another school's report card is noise that costs read time.
  const floor = (out[0]?.score || 0) * RELATIVE_FLOOR;
  return out.filter((f) => f.score >= floor).slice(0, cap);
}

/** Selection rows as stored in the analysis sidecar. */
export function toSelection(ranked: RankedFile[]): CaseSelection[] {
  return ranked.map((r) => ({ rel: r.rel, folder: r.folder, score: r.score, reason: r.reason }));
}

/**
 * Re-validate one stored selection row against the disk.
 *
 * The rows come from our own sidecar, but a sidecar is a file on disk and the
 * folder may have changed since — so everything the walk checked is checked
 * again, and a row that fails is simply dropped.
 */
function revalidate(sel: CaseSelection, paths: string[]): (WorkspaceFile & { folder: string }) | null {
  const folder = paths.find((p) => p.toLowerCase() === String(sel.folder || "").toLowerCase());
  if (!folder) return null;
  const rel = String(sel.rel || "").replace(/\\/g, "/");
  if (!rel || isAbsolute(rel) || /^[a-z]:/i.test(rel) || rel.split("/").some((s) => s === ".." || s === "" || s === ".")) return null;
  const name = rel.split("/").pop()!;
  if (SECRET_RE.test(name) || !isTextFile(name)) return null;
  if (rel.split("/").slice(0, -1).some((s) => SKIP_DIRS.has(s.toLowerCase()) || s.startsWith("."))) return null;
  try {
    const st = statSync(join(folder, rel));
    if (!st.isFile() || st.size > MAX_FILE_BYTES) return null;
    return { name: rel, folder, size: st.size, mtime: st.mtime.toISOString(), ext: extname(name).toLowerCase() };
  } catch {
    return null;
  }
}

/**
 * The census a case fix may edit: the top-level files plus the case's selected
 * files in subfolders (named by their `rel` path). Returns a new result; the
 * input is not mutated.
 */
export function withCaseFiles(en: MultiEnumResult, selection: CaseSelection[] | undefined, paths: string[]): MultiEnumResult {
  if (!selection?.length) return en;
  const folders = en.folders.map((f) => ({ ...f, files: [...f.files] }));
  const files = [...en.files];
  const have = new Set(files.map((f) => `${String(f.folder).toLowerCase()}|${f.name}`));
  for (const sel of selection) {
    const hit = revalidate(sel, paths);
    if (!hit) continue;
    const key = `${hit.folder.toLowerCase()}|${hit.name}`;
    if (have.has(key)) continue;
    have.add(key);
    files.push(hit);
    const { folder: _f, ...plain } = hit;
    folders.find((f) => f.path.toLowerCase() === hit.folder.toLowerCase())?.files.push(plain);
  }
  return { ...en, folders, files, count: files.length };
}

/**
 * A case analysis is stale when a selected file changed after it was written,
 * a selected file is gone, or the case brief was re-fetched since.
 */
export function isCaseAnalysisStale(meta: AnalysisMeta, briefFetchedAt?: string): boolean {
  const generated = Date.parse(meta.finishedAt);
  if (Number.isNaN(generated)) return true;
  if (briefFetchedAt && meta.briefFetchedAt && briefFetchedAt !== meta.briefFetchedAt) return true;
  for (const s of meta.selection || []) {
    try {
      const st = statSync(join(s.folder, s.rel));
      if (st.mtime.getTime() > generated) return true;
    } catch {
      return true;
    }
  }
  return false;
}
