/**
 * Read-only client for the team's Azure DevOps wiki.
 *
 * The Custom Team wiki (renweb / Custom Development / Custom-Team.wiki by
 * default) holds the team's standards: report-card variables, integration
 * setup guides, quoting and testing policy, SQL and ColdFusion snippets. A
 * case-scoped analysis pulls the few pages that match the case so the fix is
 * checked against how the team actually does things.
 *
 * AUTH: the user's existing Azure CLI login. `az account get-access-token` for
 * the Azure DevOps resource gives a short-lived bearer token; nothing is stored
 * on disk and the token is never logged or sent anywhere but dev.azure.com.
 * The az argv is fixed and app-authored — no user or case text reaches it.
 *
 * FAILURE IS NOT FATAL: every caller treats WikiUnavailable as "analyze without
 * wiki references" and records why as a caveat. A missing `az`, an expired
 * login or a network blip must never block the analysis itself.
 *
 * CACHE: `.analysis/wiki/` (git-ignored). The page tree and each page's content
 * are reused for 24h — the wiki changes slowly, and a case run shouldn't spend
 * its time re-downloading it.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { readEnvFile } from "./creatioClient.js";
import { ANALYSIS_DIR, writeAtomic } from "./workspace.js";

/** The Azure DevOps resource id — fixed for every ADO organization. */
const ADO_RESOURCE = "499b84ac-1321-427f-aa17-267ca6975798";

export const WIKI_DIR = join(ANALYSIS_DIR, "wiki");
const TREE_PATH = join(WIKI_DIR, "tree.json");
const PAGES_DIR = join(WIKI_DIR, "pages");

const CACHE_MS = 24 * 3_600_000;
const AZ_TIMEOUT_MS = 30_000;
const HTTP_TIMEOUT_MS = 20_000;

export type WikiFailure = "disabled" | "az-missing" | "not-logged-in" | "http";

export class WikiUnavailable extends Error {
  constructor(
    message: string,
    readonly reason: WikiFailure
  ) {
    super(message);
  }
}

export interface WikiConfig {
  org: string;
  project: string;
  wiki: string;
  enabled: boolean;
  maxPages: number;
}

export function wikiConfig(): WikiConfig {
  const env = readEnvFile();
  const n = parseInt((env.CREATIO_WIKI_MAX_PAGES || "").trim(), 10);
  return {
    org: (env.ADO_WIKI_ORG || "renweb").trim(),
    project: (env.ADO_WIKI_PROJECT || "Custom Development").trim(),
    wiki: (env.ADO_WIKI_ID || "Custom-Team.wiki").trim(),
    enabled: !/^(0|false|no|off)$/i.test((env.CREATIO_WIKI_ENABLED || "").trim()),
    maxPages: Number.isNaN(n) ? 4 : Math.max(1, Math.min(10, n)),
  };
}

function apiBase(c: WikiConfig): string {
  return (
    `https://dev.azure.com/${encodeURIComponent(c.org)}/${encodeURIComponent(c.project)}` +
    `/_apis/wiki/wikis/${encodeURIComponent(c.wiki)}/pages`
  );
}

/** Browser link for a page — what the UI and the reports show. */
export function pageUrl(c: WikiConfig, path: string, id?: number): string {
  const base =
    `https://dev.azure.com/${encodeURIComponent(c.org)}/${encodeURIComponent(c.project)}` +
    `/_wiki/wikis/${encodeURIComponent(c.wiki)}`;
  if (id) return `${base}/${id}`;
  return `${base}?pagePath=${encodeURIComponent(path)}`;
}

// ---------------------------------------------------------------------------
// Token
// ---------------------------------------------------------------------------

export type AzRunner = (args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

/** Spawn the Azure CLI. `az` is a .cmd shim on Windows, which needs a shell. */
const defaultAzRunner: AzRunner = (args) =>
  new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let child;
    if (args.some((a) => !/^[\w.:-]+$/.test(a))) {
      resolve({ code: 2, stdout: "", stderr: "Refusing an az argument with shell metacharacters." });
      return;
    }
    try {
      // On Windows the shim needs a shell. Node deprecates passing an args
      // array WITH a shell (it concatenates unescaped), so hand it one command
      // string instead — safe because every token is app-authored and fixed.
      const opts = { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] as ["ignore", "pipe", "pipe"] };
      child =
        process.platform === "win32"
          ? spawn(["az", ...args].join(" "), { ...opts, shell: true })
          : spawn("az", args, opts);
    } catch (e) {
      resolve({ code: 127, stdout: "", stderr: e instanceof Error ? e.message : String(e) });
      return;
    }
    const timer = setTimeout(() => child.kill(), AZ_TIMEOUT_MS);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: 127, stdout, stderr: stderr || e.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });

let azRunner: AzRunner = defaultAzRunner;
let cached: { token: string; expires: number } | null = null;

/** Test seam: swap the az runner and drop the cached token. */
export function setAzRunner(r: AzRunner | null): void {
  azRunner = r || defaultAzRunner;
  cached = null;
}

/** Parse `az account get-access-token -o json` output. Exported for tests. */
export function parseTokenOutput(stdout: string): { token: string; expires: number } {
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(stdout);
  } catch {
    throw new WikiUnavailable("The Azure CLI returned something that isn't a token.", "not-logged-in");
  }
  const token = typeof o.accessToken === "string" ? o.accessToken : "";
  if (!token) throw new WikiUnavailable("The Azure CLI returned no access token.", "not-logged-in");
  // `expires_on` (epoch seconds) is present on newer CLIs; `expiresOn` is a
  // local-time string on all of them.
  let expires = typeof o.expires_on === "number" ? o.expires_on * 1000 : NaN;
  if (Number.isNaN(expires) && typeof o.expiresOn === "string") expires = Date.parse(o.expiresOn);
  if (Number.isNaN(expires)) expires = Date.now() + 30 * 60_000;
  return { token, expires };
}

export async function getToken(): Promise<string> {
  if (cached && cached.expires - 5 * 60_000 > Date.now()) return cached.token;
  const r = await azRunner(["account", "get-access-token", "--resource", ADO_RESOURCE, "-o", "json"]);
  if (r.code !== 0) {
    const err = r.stderr || "";
    if (r.code === 127 || /not recognized|not found|ENOENT/i.test(err)) {
      throw new WikiUnavailable(
        "The Azure CLI (az) isn't installed, so the team wiki was skipped. Install it and run `az login`.",
        "az-missing"
      );
    }
    throw new WikiUnavailable(
      "The Azure CLI isn't logged in (or the login expired), so the team wiki was skipped. Run `az login`.",
      "not-logged-in"
    );
  }
  cached = parseTokenOutput(r.stdout);
  return cached.token;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

async function adoGet(url: string): Promise<{ json: any; etag: string }> {
  const token = await getToken();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), HTTP_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      signal: ctl.signal,
    });
  } catch (e) {
    throw new WikiUnavailable(
      `The team wiki couldn't be reached (${e instanceof Error ? e.message : String(e)}).`,
      "http"
    );
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 401 || res.status === 403) {
    cached = null;
    throw new WikiUnavailable(
      "Azure DevOps refused the Azure CLI login for the team wiki. Run `az login` with an account that can read it.",
      "not-logged-in"
    );
  }
  if (!res.ok) {
    throw new WikiUnavailable(`The team wiki returned HTTP ${res.status}.`, "http");
  }
  return { json: await res.json(), etag: res.headers.get("etag") || "" };
}

// ---------------------------------------------------------------------------
// Tree + pages
// ---------------------------------------------------------------------------

export interface WikiPageInfo {
  path: string;
  id?: number;
  /** Has sub-pages — a section rather than a leaf. */
  section: boolean;
}

interface TreeCache {
  fetchedAt: string;
  wiki: string;
  pages: WikiPageInfo[];
}

/** Flatten the ADO page tree, dropping the root and image folders. Exported for tests. */
export function flattenTree(node: any): WikiPageInfo[] {
  const out: WikiPageInfo[] = [];
  const walk = (n: any) => {
    if (!n || typeof n.path !== "string") return;
    if (/\/\.[^/]*$/.test(n.path) || n.path.includes("/.")) return; // .images, .attachments
    const subs: any[] = Array.isArray(n.subPages) ? n.subPages : [];
    if (n.path !== "/") out.push({ path: n.path, id: typeof n.id === "number" ? n.id : undefined, section: subs.length > 0 });
    for (const s of subs) walk(s);
  };
  walk(node);
  return out;
}

function fresh(iso: string | undefined): boolean {
  const t = Date.parse(iso || "");
  return !Number.isNaN(t) && Date.now() - t < CACHE_MS;
}

export async function getWikiTree(opts: { refresh?: boolean } = {}): Promise<WikiPageInfo[]> {
  const c = wikiConfig();
  if (!c.enabled) throw new WikiUnavailable("Team wiki lookup is turned off (CREATIO_WIKI_ENABLED).", "disabled");
  const key = `${c.org}/${c.project}/${c.wiki}`;
  if (!opts.refresh) {
    try {
      const doc = JSON.parse(readFileSync(TREE_PATH, "utf8")) as TreeCache;
      if (doc.wiki === key && fresh(doc.fetchedAt) && Array.isArray(doc.pages)) return doc.pages;
    } catch {
      /* no cache yet */
    }
  }
  const { json } = await adoGet(`${apiBase(c)}?path=/&recursionLevel=Full&api-version=7.1`);
  const pages = flattenTree(json);
  const doc: TreeCache = { fetchedAt: new Date().toISOString(), wiki: key, pages };
  writeAtomic(TREE_PATH, JSON.stringify(doc, null, 2));
  return pages;
}

export interface WikiPage {
  path: string;
  id?: number;
  url: string;
  content: string;
}

function pageCachePath(key: string): string {
  return join(PAGES_DIR, createHash("sha1").update(key).digest("hex").slice(0, 16) + ".json");
}

/**
 * Tidy page Markdown for a prompt: drop image embeds (the analysis can't see
 * them and they're pure noise), keep links and text.
 */
export function cleanPageContent(md: string): string {
  return String(md || "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/<img\b[^>]*>/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export async function getWikiPage(path: string, opts: { refresh?: boolean } = {}): Promise<WikiPage> {
  const c = wikiConfig();
  if (!c.enabled) throw new WikiUnavailable("Team wiki lookup is turned off (CREATIO_WIKI_ENABLED).", "disabled");
  const key = `${c.org}/${c.project}/${c.wiki}|${path}`;
  const file = pageCachePath(key);
  if (!opts.refresh) {
    try {
      const doc = JSON.parse(readFileSync(file, "utf8"));
      if (doc.key === key && fresh(doc.fetchedAt)) return doc.page as WikiPage;
    } catch {
      /* not cached */
    }
  }
  const { json } = await adoGet(
    `${apiBase(c)}?path=${encodeURIComponent(path)}&includeContent=true&api-version=7.1`
  );
  const id = typeof json.id === "number" ? json.id : undefined;
  const page: WikiPage = {
    path: typeof json.path === "string" ? json.path : path,
    id,
    url: pageUrl(c, path, id),
    content: cleanPageContent(json.content || ""),
  };
  writeAtomic(file, JSON.stringify({ key, fetchedAt: new Date().toISOString(), page }, null, 2));
  return page;
}

/** Settings-tab probe: can we log in and list the wiki? */
export async function testWiki(): Promise<{ ok: boolean; pages?: number; message: string; reason?: WikiFailure }> {
  try {
    const pages = await getWikiTree({ refresh: true });
    const c = wikiConfig();
    return { ok: true, pages: pages.length, message: `Connected to ${c.wiki} — ${pages.length} pages.` };
  } catch (e) {
    if (e instanceof WikiUnavailable) return { ok: false, message: e.message, reason: e.reason };
    return { ok: false, message: e instanceof Error ? e.message : String(e), reason: "http" };
  }
}
