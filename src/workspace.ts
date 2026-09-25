/**
 * Workspace directory: validation, top-level file enumeration, and the
 * `.analysis/` artifact store.
 *
 * Pure filesystem + config. No Claude, no HTTP — those live in
 * ./analyzeWorkspace.ts and ./server.ts.
 *
 * THREAT MODEL — read this before "hardening" anything here.
 *   The web app binds 127.0.0.1 only, is single-user, and already writes .env
 *   from its Settings screen. The user types their own path into their own tool.
 *   There is no attacker to defend against here, only mistakes. So: no jail, no
 *   allowlist, no canonicalization theatre. The path never becomes an argv token
 *   either — it becomes the analysis child's cwd — so there is no shell-injection
 *   surface.
 *
 *   The two footguns that ARE worth preventing:
 *     1. Pointing at C:\ or C:\Windows and enumerating/analyzing something
 *        enormous. Handled by validateWorkspacePath's root/denylist checks plus
 *        single-level (never recursive) enumeration and a dirent ceiling.
 *     2. Handing secrets to the analysis child. Handled here by never listing
 *        secret-bearing files, and in analyzeWorkspace.ts by Read() deny rules.
 *
 * ARTIFACTS live under `.analysis/` in THIS repo, never in the user's workspace
 * — writing into a directory the user might deploy or commit is its own hazard.
 */

import { createHash } from "node:crypto";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { dirname, extname, isAbsolute, join, normalize, parse, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { readEnvFile, writeEnvFile } from "./creatioClient.js";

// `.analysis/` sits at the project root, resolved exactly like ENV_PATH
// (../.analysis relative to dist/workspace.js).
export const ANALYSIS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", ".analysis");
export const INDEX_PATH = join(ANALYSIS_DIR, "index.json");

export const WORKSPACE_ENV_KEY = "CREATIO_WORKSPACE_PATH";

/**
 * How many folders can make up one workspace.
 *
 * Stored as numbered .env keys (CREATIO_WORKSPACE_PATH, _2, _3) rather than one
 * delimited value: a Windows path can legitimately contain most separators, and
 * a bad split would silently point the analyzer at the wrong folder.
 */
export const MAX_PATHS = 3;

function pathKey(i: number): string {
  return i === 0 ? WORKSPACE_ENV_KEY : `${WORKSPACE_ENV_KEY}_${i + 1}`;
}

/** Default top-level file cap. Above this the caller must ask the user first. */
const DEFAULT_FILE_CAP = 10;
/** Files bigger than this would eat the child's context for one file. */
export const MAX_FILE_BYTES = 512 * 1024;
/** Stop reading dirents past this — bounds any mistake the denylist missed. */
const MAX_ENTRIES = 2000;

export class WorkspacePathError extends Error {}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/**
 * The configured workspace folders, read LIVE from the .env file (not
 * process.env) so a save from the Workspace tab takes effect without restarting
 * the app — same rationale as the SSO cookies in creatioClient.ts.
 *
 * Returns [] when nothing is configured. Blank slots are dropped, so
 * ["", "C:\\b", ""] collapses to ["C:\\b"].
 */
export function getWorkspacePaths(): string[] {
  const env = readEnvFile();
  const out: string[] = [];
  for (let i = 0; i < MAX_PATHS; i++) {
    const v = (env[pathKey(i)] || "").trim();
    if (v) out.push(v);
  }
  return out;
}

/** The first configured folder — the one the analyzer uses as its cwd. */
export function getWorkspacePath(): string {
  return getWorkspacePaths()[0] || "";
}

/**
 * Replace the configured folders. Always writes all MAX_PATHS keys so removing
 * a folder actually clears its slot rather than leaving a stale value behind.
 */
export function setWorkspacePaths(paths: string[]): void {
  const updates: Record<string, string> = {};
  for (let i = 0; i < MAX_PATHS; i++) updates[pathKey(i)] = paths[i] || "";
  writeEnvFile(updates);
}

export function fileCap(): number {
  const raw = (readEnvFile().CREATIO_WORKSPACE_FILE_CAP || "").trim();
  const n = raw ? parseInt(raw, 10) : NaN;
  if (Number.isNaN(n)) return DEFAULT_FILE_CAP;
  return Math.max(1, Math.min(200, n));
}

// ---------------------------------------------------------------------------
// Path validation
// ---------------------------------------------------------------------------

/**
 * Folders a user almost certainly didn't mean to analyze. Compared against the
 * canonical path itself (not its children) so `C:\Users\me\projects` is fine
 * while `C:\Users\me` is not.
 */
function denylistedExactly(abs: string): string | null {
  const home = (process.env.USERPROFILE || process.env.HOME || "").replace(/[\\/]+$/, "");
  const exact: string[] = [];
  if (home) {
    exact.push(home);
    for (const d of ["Downloads", "Desktop", "Documents", "OneDrive"]) exact.push(join(home, d));
  }
  const lower = abs.toLowerCase();
  for (const e of exact) {
    if (e && lower === e.toLowerCase()) return e;
  }
  return null;
}

/** System trees that are never a project — matched as a prefix. */
const DENY_PREFIXES = [
  "c:\\windows",
  "c:\\program files",
  "c:\\program files (x86)",
  "c:\\programdata",
  "c:\\$recycle.bin",
  "/usr",
  "/etc",
  "/bin",
  "/sbin",
  "/system",
  "/library",
];

/** Path segments that mean "you pointed at build output or a dependency tree". */
const DENY_SEGMENTS = new Set(["node_modules", ".git"]);

/**
 * Validate and canonicalize a user-typed absolute directory path.
 * Throws WorkspacePathError with a message meant to be shown to the user verbatim.
 */
export function validateWorkspacePath(raw: string): string {
  const input = (raw || "").trim();
  if (!input) throw new WorkspacePathError("Enter the folder you're working in.");

  // These characters would corrupt the KEY=VALUE line in .env.
  if (/[\0"'=#\r\n]/.test(input)) {
    throw new WorkspacePathError(
      "Path contains a character that can't be stored in .env (quote, =, # or a line break)."
    );
  }

  const win = process.platform === "win32";
  // On Windows require a drive letter. This is what rejects UNC (\\server\share),
  // extended (\\?\C:\...) and device (\\.\PIPE\...) paths, none of which this
  // tool supports.
  if (win && !/^[A-Za-z]:[\\/]/.test(input)) {
    throw new WorkspacePathError(
      "Enter a full local path starting with a drive letter, e.g. C:\\projects\\myapp. " +
        "Network (\\\\server) paths aren't supported."
    );
  }
  if (!win && !isAbsolute(input)) {
    throw new WorkspacePathError("Enter a full path starting with /.");
  }

  // Canonicalize, and strip trailing separators so C:\x\ and C:\x slug alike.
  let abs = resolve(normalize(input));
  const root = parse(abs).root;
  if (abs.length > root.length) abs = abs.replace(/[\\/]+$/, "");

  const rootBare = root.replace(/[\\/]+$/, "").toLowerCase();
  if (abs.toLowerCase() === root.toLowerCase() || abs.toLowerCase() === rootBare) {
    throw new WorkspacePathError("That's a drive root. Pick a project folder inside it.");
  }

  const lower = abs.toLowerCase();
  for (const p of DENY_PREFIXES) {
    if (lower === p || lower.startsWith(p + "\\") || lower.startsWith(p + "/")) {
      throw new WorkspacePathError(
        `${abs} is a system folder, not a project directory. Pick the folder you're working in.`
      );
    }
  }
  const exact = denylistedExactly(abs);
  if (exact) {
    throw new WorkspacePathError(
      `${abs} is too broad to analyze. Pick the specific project folder inside it.`
    );
  }
  for (const seg of abs.split(/[\\/]/)) {
    if (DENY_SEGMENTS.has(seg.toLowerCase())) {
      throw new WorkspacePathError(
        `That path goes through "${seg}", which isn't source you'd edit. Pick the project folder itself.`
      );
    }
  }

  // Stat AND enumerate here, so a folder that stats but won't list fails now —
  // at Save time, with a clear message — rather than mid-stream during analysis.
  try {
    const st = statSync(abs);
    if (!st.isDirectory()) {
      throw new WorkspacePathError("That's a file, not a folder. Enter the folder that contains it.");
    }
    readdirSync(abs);
  } catch (e) {
    if (e instanceof WorkspacePathError) throw e;
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new WorkspacePathError("That folder doesn't exist.");
    if (code === "EACCES" || code === "EPERM") {
      throw new WorkspacePathError("That folder can't be read by this app (permission denied).");
    }
    if (code === "ENOTDIR") {
      throw new WorkspacePathError("That's a file, not a folder. Enter the folder that contains it.");
    }
    throw new WorkspacePathError(
      `That folder couldn't be opened: ${e instanceof Error ? e.message : String(e)}`
    );
  }

  return abs;
}

// ---------------------------------------------------------------------------
// Enumeration
// ---------------------------------------------------------------------------

/** Extensions treated as readable source/text. .cfm/.cfc matter — the FACTS SIS
 *  report templates this tool supports are ColdFusion. */
const TEXT_EXT = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".jsonc",
  ".md", ".markdown", ".txt", ".rst",
  ".css", ".scss", ".sass", ".less",
  ".html", ".htm", ".xml", ".xsl", ".xslt", ".svg",
  ".yml", ".yaml", ".toml", ".ini", ".cfg", ".conf", ".properties",
  ".sh", ".bash", ".zsh", ".bat", ".cmd", ".ps1", ".psm1",
  ".py", ".rb", ".pl", ".php", ".go", ".rs", ".java", ".kt", ".swift",
  ".c", ".h", ".cpp", ".hpp", ".cc", ".cs", ".cshtml", ".razor", ".vb",
  ".sql", ".cfm", ".cfc", ".jsp", ".asp", ".aspx",
  ".vue", ".svelte", ".astro",
  ".csv", ".tsv", ".graphql", ".gql", ".proto",
]);

/** Extensionless or dotfile names that are still text worth reading. */
const TEXT_NAMES = new Set([
  "dockerfile", "makefile", "rakefile", "gemfile", "procfile", "brewfile",
  "license", "licence", "readme", "changelog", "authors", "notice", "codeowners",
  ".gitignore", ".gitattributes", ".editorconfig", ".npmrc", ".nvmrc",
  ".dockerignore", ".prettierrc", ".eslintrc", ".babelrc", ".browserslistrc",
]);

/** Files that may hold credentials. Counted, never listed, never sent to a child. */
export const SECRET_RE = /^\.env($|\.)|\.(pem|key|pfx|p12|crt|cer|der|jks|keystore|ppk)$|^id_(rsa|dsa|ecdsa|ed25519)/i;

/** Directories that are build output, dependencies, or tooling state. */
export const SKIP_DIRS = new Set([
  ".git", "node_modules", "dist", "build", "out", "target", ".next", ".nuxt",
  ".svelte-kit", ".venv", "venv", "env", "__pycache__", ".pytest_cache",
  ".mypy_cache", ".tox", "bin", "obj", "coverage", ".cache", ".parcel-cache",
  ".vs", ".vscode", ".idea", ".gradle", "vendor", ".terraform", ".analysis",
  ".browser-profile",
]);

export interface WorkspaceFile {
  name: string;
  size: number;
  mtime: string;
  ext: string;
}

/** A file in a stored analysis, tagged with the folder it came from. */
export type AnalyzedFile = WorkspaceFile & { folder?: string };

export interface EnumSkipped {
  binaries: number;
  oversized: number;
  secrets: number;
  unreadable: number;
  entriesTruncated: boolean;
}

export interface EnumResult {
  path: string;
  files: WorkspaceFile[];
  count: number;
  cap: number;
  overCap: boolean;
  dirs: string[];
  skipped: EnumSkipped;
}

export function isTextFile(name: string): boolean {
  const lower = name.toLowerCase();
  if (TEXT_NAMES.has(lower)) return true;
  const ext = extname(lower);
  return Boolean(ext) && TEXT_EXT.has(ext);
}

/**
 * List the top-level source/text files of a directory.
 *
 * SINGLE LEVEL, NEVER RECURSIVE. That is the cap rule, and it's also what makes
 * pointing at a huge tree cheap instead of catastrophic. Subdirectory names are
 * returned for context only.
 *
 * `dir` must already have been through validateWorkspacePath().
 */
export function enumerateWorkspace(dir: string): EnumResult {
  const files: WorkspaceFile[] = [];
  const dirs: string[] = [];
  const skipped: EnumSkipped = {
    binaries: 0,
    oversized: 0,
    secrets: 0,
    unreadable: 0,
    entriesTruncated: false,
  };

  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    throw new WorkspacePathError(
      `That folder couldn't be listed: ${e instanceof Error ? e.message : String(e)}`
    );
  }

  if (entries.length > MAX_ENTRIES) {
    skipped.entriesTruncated = true;
    entries = entries.slice(0, MAX_ENTRIES);
  }

  for (const entry of entries) {
    const name = entry.name;

    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(name.toLowerCase())) dirs.push(name);
      continue;
    }
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;

    if (SECRET_RE.test(name)) {
      skipped.secrets++;
      continue;
    }
    if (!isTextFile(name)) {
      skipped.binaries++;
      continue;
    }

    let st: import("node:fs").Stats;
    try {
      st = statSync(join(dir, name));
    } catch {
      skipped.unreadable++;
      continue;
    }
    if (!st.isFile()) continue; // a symlink to a directory
    if (st.size > MAX_FILE_BYTES) {
      skipped.oversized++;
      continue;
    }

    files.push({
      name,
      size: st.size,
      mtime: st.mtime.toISOString(),
      ext: extname(name).toLowerCase(),
    });
  }

  files.sort((a, b) => a.name.localeCompare(b.name));
  dirs.sort((a, b) => a.localeCompare(b));

  const cap = fileCap();
  return { path: dir, files, count: files.length, cap, overCap: files.length > cap, dirs, skipped };
}

export interface MultiEnumResult {
  /** One entry per configured folder, in order. */
  folders: EnumResult[];
  /** Total files across every folder — what the cap is measured against. */
  count: number;
  cap: number;
  overCap: boolean;
  /** Every file, tagged with the folder it came from. */
  files: (WorkspaceFile & { folder: string })[];
  skipped: EnumSkipped;
}

/**
 * Enumerate up to MAX_PATHS folders as ONE workspace.
 *
 * The cap is applied to the TOTAL, not per folder — the point of the cap is
 * "the analysis stays fast", and three folders of ten files each is thirty
 * files to read however they're grouped.
 *
 * Each path must already have been through validateWorkspacePath().
 */
export function enumerateWorkspaces(dirs: string[]): MultiEnumResult {
  const folders = dirs.map((d) => enumerateWorkspace(d));
  const files = folders.flatMap((f) => f.files.map((x) => ({ ...x, folder: f.path })));
  const skipped: EnumSkipped = {
    binaries: 0,
    oversized: 0,
    secrets: 0,
    unreadable: 0,
    entriesTruncated: false,
  };
  for (const f of folders) {
    skipped.binaries += f.skipped.binaries;
    skipped.oversized += f.skipped.oversized;
    skipped.secrets += f.skipped.secrets;
    skipped.unreadable += f.skipped.unreadable;
    skipped.entriesTruncated = skipped.entriesTruncated || f.skipped.entriesTruncated;
  }
  const cap = fileCap();
  return { folders, count: files.length, cap, overCap: files.length > cap, files, skipped };
}

// ---------------------------------------------------------------------------
// Artifact store
// ---------------------------------------------------------------------------

/**
 * `case` is a case-scoped analysis: only the files the app ranked as related to
 * one bound case (searched recursively), plus the team-wiki pages that match
 * it. `target` is the SR number.
 */
export type AnalysisMode = "directory" | "file" | "case";
export type AnalysisStatus = "complete" | "stopped" | "timeout";

/** One file the case-scoped selection picked, and why. */
export interface CaseSelection {
  /** Forward-slash path relative to `folder` — "EP-JAM/ReportCard.cfm". */
  rel: string;
  folder: string;
  score: number;
  reason: string;
}

/** A team-wiki page fed into a case-scoped analysis. */
export interface WikiRef {
  path: string;
  url: string;
  why: string;
}

export interface AnalysisMeta {
  version: 1;
  slug: string;
  /** The first folder — the analyzer's cwd. Kept for single-folder readers. */
  path: string;
  /** Every folder in the workspace, in order. */
  paths: string[];
  mode: AnalysisMode;
  target: string | null;
  startedAt: string;
  finishedAt: string;
  durationMs?: number;
  model?: string;
  cap: number;
  capExceeded: boolean;
  proceededOverCap: boolean;
  filesAnalyzed: AnalyzedFile[];
  dirsPresent: string[];
  skipped: EnumSkipped;
  /** One boolean callers can trust: the report rests on partial information. */
  truncated: boolean;
  toolCalls: { name: string; target?: string }[];
  usage: { costUsd?: number; totalTokens?: number };
  status: AnalysisStatus;
  report: string;
  /** Case mode only: the ranked files handed to the analysis. */
  selection?: CaseSelection[];
  /** Case mode only: the team-wiki pages handed to the analysis. */
  wikiPages?: WikiRef[];
  /** Case mode only: the sanitized keywords the selection was ranked by. */
  terms?: string[];
  /** Case mode only: when the brief used for the selection was fetched. */
  briefFetchedAt?: string;
  /** Case mode only: why the wiki wasn't consulted, when it wasn't. */
  wikiSkipped?: string;
}

export interface IndexFileEntry {
  name: string;
  report: string;
  meta: string;
  finishedAt: string;
  status: AnalysisStatus;
  truncated: boolean;
}

export interface IndexEntry {
  slug: string;
  path: string;
  paths: string[];
  directory: {
    report: string;
    meta: string;
    finishedAt: string;
    fileCount: number;
    truncated: boolean;
    status: AnalysisStatus;
  } | null;
  files: IndexFileEntry[];
  /** Case-scoped analyses, keyed by SR number in `name`. Absent on old indexes. */
  cases?: IndexFileEntry[];
}

interface IndexDoc {
  version: 1;
  updatedAt: string;
  workspaces: IndexEntry[];
}

/**
 * Stable directory name for a workspace path: a readable prefix plus a hash so
 * two different paths can never collide. Not reversible — the full path is
 * recorded in index.json, analysis.json and the report's front matter.
 */
export function slugForPath(abs: string): string {
  const norm = resolve(abs).replace(/[\\/]+$/, "");
  // Windows filesystems are case-insensitive, so C:\Foo and c:\foo are one
  // workspace and must produce one slug.
  const key = process.platform === "win32" ? norm.toLowerCase() : norm;
  const hash = createHash("sha1").update(key).digest("hex").slice(0, 8);
  const base = key
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "")
    .toLowerCase();
  return `${base || "workspace"}-${hash}`;
}

/**
 * Slug for a workspace made of one or more folders. The readable prefix comes
 * from the first folder; the hash covers the whole ordered list, so adding or
 * removing a folder yields a different workspace rather than silently reusing
 * the previous report.
 *
 * A single folder delegates to slugForPath, so reports stored before multi-folder
 * support still resolve.
 */
export function slugForPaths(paths: string[]): string {
  if (paths.length <= 1) return slugForPath(paths[0] || "");
  const norm = paths.map((p) => {
    const n = resolve(p).replace(/[\\/]+$/, "");
    return process.platform === "win32" ? n.toLowerCase() : n;
  });
  const hash = createHash("sha1").update(norm.join("\u0000")).digest("hex").slice(0, 8);
  const base = norm[0]
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/, "")
    .toLowerCase();
  return `${base || "workspace"}-plus${norm.length - 1}-${hash}`;
}

/** Stable file name for a single-file analysis within a workspace. */
export function slugForFile(name: string): string {
  const base = name
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  if (base.length <= 80) return base || "file";
  const hash = createHash("sha1").update(name).digest("hex").slice(0, 8);
  return `${base.slice(0, 70).replace(/-+$/, "")}-${hash}`;
}

/** Relative POSIX path, as stored in index.json and reported to callers. */
function relPath(...parts: string[]): string {
  return [".analysis", ...parts].join("/");
}

function artifactPaths(meta: Pick<AnalysisMeta, "slug" | "mode" | "target">): {
  dir: string;
  md: string;
  json: string;
  relMd: string;
  relJson: string;
} {
  if (meta.mode === "case") {
    // The target is a validated SR number, so it's already a safe file name.
    const n = /^SR\d{4,12}$/.test(meta.target || "") ? meta.target! : slugForFile(meta.target || "case");
    const dir = join(ANALYSIS_DIR, meta.slug, "cases");
    return {
      dir,
      md: join(dir, `${n}.md`),
      json: join(dir, `${n}.json`),
      relMd: relPath(meta.slug, "cases", `${n}.md`),
      relJson: relPath(meta.slug, "cases", `${n}.json`),
    };
  }
  if (meta.mode === "file") {
    const fs = slugForFile(meta.target || "file");
    const dir = join(ANALYSIS_DIR, meta.slug, "files");
    return {
      dir,
      md: join(dir, `${fs}.md`),
      json: join(dir, `${fs}.json`),
      relMd: relPath(meta.slug, "files", `${fs}.md`),
      relJson: relPath(meta.slug, "files", `${fs}.json`),
    };
  }
  const dir = join(ANALYSIS_DIR, meta.slug);
  return {
    dir,
    md: join(dir, "analysis.md"),
    json: join(dir, "analysis.json"),
    relMd: relPath(meta.slug, "analysis.md"),
    relJson: relPath(meta.slug, "analysis.json"),
  };
}

// ---------------------------------------------------------------------------
// Writing a file INTO a workspace folder
//
// This is the only path in the app that writes outside this repo other than an
// approved fix apply, so the rules are deliberately narrow.
//
// Raster images only. The bytes come from a Creatio attachment — uploaded by a
// CLIENT — and a workspace folder here holds ColdFusion templates that a server
// may execute. Dropping a client-supplied `.cfm`, `.bat` or `.exe` into it would
// be a genuine code-execution risk, so the extension allowlist is the control.
// `.svg` is excluded on purpose: it can carry script and gets rendered.
// ---------------------------------------------------------------------------

export const WRITABLE_IMAGE_EXT = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico"];

/**
 * Identify an image from its leading bytes.
 *
 * The extension allowlist only checks the NAME. These bytes come from a client
 * upload, so the name proves nothing: without this, arbitrary content named
 * `logo.png` would be written. Sniffing also catches the subtler case of
 * renaming a .jpeg to .png, which produces a file whose extension lies about
 * what is inside it.
 */
export function sniffImageType(b: Buffer): { ext: string[]; label: string } | null {
  const at = (i: number) => (i < b.length ? b[i] : -1);
  if (at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47) {
    return { ext: [".png"], label: "PNG" };
  }
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) {
    return { ext: [".jpg", ".jpeg"], label: "JPEG" };
  }
  if (b.length >= 6 && b.subarray(0, 3).toString("latin1") === "GIF") {
    return { ext: [".gif"], label: "GIF" };
  }
  if (
    b.length >= 12 &&
    b.subarray(0, 4).toString("latin1") === "RIFF" &&
    b.subarray(8, 12).toString("latin1") === "WEBP"
  ) {
    return { ext: [".webp"], label: "WebP" };
  }
  if (at(0) === 0x42 && at(1) === 0x4d) return { ext: [".bmp"], label: "BMP" };
  if (at(0) === 0x00 && at(1) === 0x00 && at(2) === 0x01 && at(3) === 0x00) {
    return { ext: [".ico"], label: "icon" };
  }
  return null;
}

/** Bounds a single dropped-in asset. */
const MAX_ASSET_BYTES = 10 * 1024 * 1024;

export type WorkspaceWriteCode =
  | "folder"
  | "name"
  | "ext"
  | "exists"
  | "size"
  | "content"
  | "mismatch";

export class WorkspaceWriteError extends Error {
  constructor(
    message: string,
    readonly code: WorkspaceWriteCode
  ) {
    super(message);
  }
}

/**
 * Reduce an attachment's name to a safe basename.
 *
 * Creatio filenames are client-supplied, so this keeps only the last path
 * segment and a conservative character set — there is no path left to traverse
 * with by the time it is joined onto a folder.
 */
export function safeAssetName(raw: string): string {
  const base = String(raw || "")
    .replace(/^.*[\\/]/, "")
    .trim();
  if (!base || base === "." || base === "..") {
    throw new WorkspaceWriteError("That attachment has no usable file name.", "name");
  }
  const safe = base.replace(/[^A-Za-z0-9._ -]+/g, "_").replace(/^[.]+/, "");
  if (!safe) {
    throw new WorkspaceWriteError("That file name can't be used on disk.", "name");
  }
  // Truncate the stem, never the extension — cutting the extension off would
  // make a long-named image look like a rejected file type.
  const rawExt = extname(safe);
  const stem = safe.slice(0, safe.length - rawExt.length) || "file";
  const cleaned = stem.slice(0, 100) + rawExt;
  const ext = rawExt.toLowerCase();
  if (!WRITABLE_IMAGE_EXT.includes(ext)) {
    throw new WorkspaceWriteError(
      `Only image files can be saved into a workspace folder (${WRITABLE_IMAGE_EXT.join(", ")}). ` +
        `"${base}" is not one — open it in a new tab instead.`,
      "ext"
    );
  }
  return cleaned;
}

/**
 * Write an image into one of the configured workspace folders.
 *
 * Refuses to clobber silently: an existing file needs `overwrite`, and the
 * original is copied into `.analysis/assets/` first so the replacement can be
 * undone even when the folder isn't a git repository.
 */
export function saveAssetToWorkspace(
  folder: string,
  rawName: string,
  bytes: Buffer,
  opts: { overwrite?: boolean; allowed: string[] }
): { path: string; name: string; backup?: string; overwrote: boolean } {
  const target = opts.allowed.find((p) => p.toLowerCase() === String(folder || "").toLowerCase());
  if (!target) {
    throw new WorkspaceWriteError(
      "That folder isn't one of the configured workspace folders.",
      "folder"
    );
  }
  if (!bytes?.length) {
    throw new WorkspaceWriteError("The attachment came back empty.", "size");
  }
  if (bytes.length > MAX_ASSET_BYTES) {
    throw new WorkspaceWriteError("That attachment is larger than 10 MB.", "size");
  }

  // The name must match what the bytes actually are — see sniffImageType().
  const kind = sniffImageType(bytes);
  if (!kind) {
    throw new WorkspaceWriteError(
      "That attachment isn't a recognisable image (PNG, JPEG, GIF, WebP, BMP or icon), so it won't be written into a source folder.",
      "content"
    );
  }

  const name = safeAssetName(rawName);
  const nameExt = extname(name).toLowerCase();
  if (!kind.ext.includes(nameExt)) {
    throw new WorkspaceWriteError(
      `That file is a ${kind.label} image, so it can't be saved as "${name}". ` +
        `Use ${kind.ext.join(" or ")} instead — an extension that doesn't match the contents breaks some viewers.`,
      "mismatch"
    );
  }

  const dest = join(target, name);
  const exists = existsSync(dest);

  if (exists && !opts.overwrite) {
    throw new WorkspaceWriteError(
      `"${name}" already exists in that folder. Confirm to replace it — the current file is backed up first.`,
      "exists"
    );
  }

  let backup: string | undefined;
  if (exists) {
    backup = join(
      ANALYSIS_DIR,
      "assets",
      `${new Date().toISOString().replace(/[:.]/g, "-")}-${name}`
    );
    mkdirSync(dirname(backup), { recursive: true });
    writeFileSync(backup, readFileSync(dest));
  }

  const tmp = `${dest}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, bytes);
  renameSync(tmp, dest);

  return { path: dest, name, backup, overwrote: exists };
}

/** Write via a temp file + rename so a reader never sees a half-written file. */
export function writeAtomic(target: string, body: string): void {
  mkdirSync(dirname(target), { recursive: true });
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, body, "utf8");
  renameSync(tmp, target);
}

/**
 * YAML single-quoted scalar. A Windows path contains `:` after the drive letter,
 * which a bare YAML scalar reads as a mapping — so every path MUST be quoted
 * this way or a consumer's YAML parse breaks.
 */
function yamlStr(v: string): string {
  return `'${String(v).replace(/'/g, "''")}'`;
}

function frontMatter(meta: AnalysisMeta): string {
  return [
    "---",
    `workspace: ${yamlStr(meta.path)}`,
    `slug: ${yamlStr(meta.slug)}`,
    `mode: ${meta.mode}`,
    `target: ${meta.target ? yamlStr(meta.target) : "null"}`,
    `generated: ${yamlStr(meta.finishedAt)}`,
    `model: ${meta.model ? yamlStr(meta.model) : "null"}`,
    `files_analyzed: ${meta.filesAnalyzed.length}`,
    `truncated: ${meta.truncated}`,
    `status: ${meta.status}`,
    "---",
    "",
  ].join("\n");
}

function readIndex(): IndexDoc {
  try {
    const doc = JSON.parse(readFileSync(INDEX_PATH, "utf8"));
    if (doc && typeof doc === "object" && Array.isArray(doc.workspaces)) return doc as IndexDoc;
    throw new Error("shape");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      return { version: 1, updatedAt: new Date().toISOString(), workspaces: [] };
    }
    // Corrupt index: move it aside rather than lose the reports it pointed at.
    // The reports themselves are the source of truth; the index is a convenience.
    try {
      renameSync(INDEX_PATH, join(ANALYSIS_DIR, `index.corrupt-${Date.now()}.json`));
    } catch {
      /* ignore */
    }
    return { version: 1, updatedAt: new Date().toISOString(), workspaces: [] };
  }
}

function upsertIndex(meta: AnalysisMeta, paths: { relMd: string; relJson: string }): void {
  const doc = readIndex();
  let entry = doc.workspaces.find((w) => w.slug === meta.slug);
  if (!entry) {
    entry = { slug: meta.slug, path: meta.path, paths: meta.paths, directory: null, files: [] };
    doc.workspaces.push(entry);
  }
  // Keep the original casing fresh.
  entry.path = meta.path;
  entry.paths = meta.paths;

  if (meta.mode === "directory") {
    entry.directory = {
      report: paths.relMd,
      meta: paths.relJson,
      finishedAt: meta.finishedAt,
      fileCount: meta.filesAnalyzed.length,
      truncated: meta.truncated,
      status: meta.status,
    };
  } else {
    const name = meta.target || meta.mode;
    const row: IndexFileEntry = {
      name,
      report: paths.relMd,
      meta: paths.relJson,
      finishedAt: meta.finishedAt,
      status: meta.status,
      truncated: meta.truncated,
    };
    const list = meta.mode === "case" ? (entry.cases ||= []) : entry.files;
    const i = list.findIndex((f) => f.name === name);
    if (i === -1) list.push(row);
    else list[i] = row;
    list.sort((a, b) => a.name.localeCompare(b.name));
  }

  doc.updatedAt = new Date().toISOString();
  doc.workspaces.sort((a, b) => a.path.localeCompare(b.path));
  writeAtomic(INDEX_PATH, JSON.stringify(doc, null, 2) + "\n");
}

/**
 * Persist one analysis: report, sidecar, then the index.
 *
 * Order matters — index.json is written LAST so a crash can never leave the
 * index pointing at a report that isn't on disk.
 */
export function saveAnalysis(meta: AnalysisMeta, markdown: string): { report: string; meta: string } {
  const paths = artifactPaths(meta);
  const stored: AnalysisMeta = { ...meta, report: paths.relMd };
  writeAtomic(paths.md, frontMatter(stored) + markdown.trimEnd() + "\n");
  writeAtomic(paths.json, JSON.stringify(stored, null, 2) + "\n");
  upsertIndex(stored, paths);
  return { report: paths.relMd, meta: paths.relJson };
}

export interface LoadedAnalysis {
  meta: AnalysisMeta;
  markdown: string;
  /** Report body with the YAML front matter removed. */
  body: string;
}

/** Read back a stored analysis for a workspace of one or more folders. */
export function loadAnalysisFor(
  absPaths: string[],
  mode: AnalysisMode = "directory",
  target?: string
): LoadedAnalysis | null {
  return loadAnalysisBySlug(slugForPaths(absPaths), mode, target);
}

/** Read back a stored analysis, or null if there isn't one. */
export function loadAnalysis(
  absPath: string,
  mode: AnalysisMode = "directory",
  target?: string
): LoadedAnalysis | null {
  return loadAnalysisBySlug(slugForPath(absPath), mode, target);
}

function loadAnalysisBySlug(
  slug: string,
  mode: AnalysisMode,
  target?: string
): LoadedAnalysis | null {
  const paths = artifactPaths({ slug, mode, target: target ?? null });
  if (!existsSync(paths.md) || !existsSync(paths.json)) return null;
  try {
    const meta = JSON.parse(readFileSync(paths.json, "utf8")) as AnalysisMeta;
    const markdown = readFileSync(paths.md, "utf8");
    const body = markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n+/, "");
    return { meta, markdown, body };
  } catch {
    return null;
  }
}

/** Everything in the store, newest workspace first. */
export function listAnalyses(): IndexEntry[] {
  return readIndex().workspaces;
}

/** The index entry for one path, or null. */
export function indexEntryFor(absPaths: string[] | string): IndexEntry | null {
  const slug = Array.isArray(absPaths) ? slugForPaths(absPaths) : slugForPath(absPaths);
  return readIndex().workspaces.find((w) => w.slug === slug) || null;
}

/**
 * True when a stored analysis is older than the newest mtime among the files it
 * covered, or the set of files has changed — i.e. don't trust this report.
 *
 * Files are keyed by folder + name, because two folders in one workspace can
 * each contain an `index.html`.
 */
export function isStale(meta: AnalysisMeta, current: MultiEnumResult): boolean {
  const generated = Date.parse(meta.finishedAt);
  if (Number.isNaN(generated)) return true;
  for (const f of current.files) {
    const m = Date.parse(f.mtime);
    if (!Number.isNaN(m) && m > generated) return true;
  }
  const key = (folder: string | undefined, name: string) => `${(folder || "").toLowerCase()}|${name}`;
  const before = new Set(meta.filesAnalyzed.map((f) => key(f.folder, f.name)));
  return current.files.some((f) => !before.has(key(f.folder, f.name)));
}
