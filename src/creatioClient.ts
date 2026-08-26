/**
 * Shared, read-only Creatio OData client.
 *
 * SAFETY MODEL
 *  - Every network call goes through odataGet(), whose HTTP method is hard-coded
 *    to GET. There is no create/update/delete path anywhere in this module, so
 *    every consumer (MCP server, web app) is read-only by construction.
 *  - An optional entity allowlist (CREATIO_ALLOWED_ENTITIES) restricts which
 *    OData entity sets are reachable; $top is clamped to CREATIO_MAX_TOP.
 *
 * AUTH — two modes, auto-selected:
 *  1. Forms auth via /ServiceModel/AuthService.svc/Login (CREATIO_LOGIN +
 *     CREATIO_PASSWORD). Session re-established automatically on 401.
 *  2. Cookie auth (CREATIO_ASPXAUTH + CREATIO_BPMCSRF [+ CREATIO_BPMLOADER]) for
 *     SSO tenants. The cookies live in the .env FILE and are re-read on demand,
 *     so refreshing them there takes effect on the next query — no restart.
 */

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";

// .env sits next to the project root (../.env relative to dist/creatioClient.js).
export const ENV_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", ".env");

// Load .env into process.env for stable config (base URL, allowlist, row cap).
// NOTE: loadEnvFile does NOT override vars already in process.env, so anything
// the MCP client baked into its registration wins here — fine for stable config.
// SSO cookies are handled separately (resolveCookieEnv), reading the file live.
try {
  (process as { loadEnvFile?: (p: string) => void }).loadEnvFile?.(ENV_PATH);
} catch {
  // No .env next to the module — fall back to whatever is already in process.env.
}

/**
 * Parse KEY=VALUE lines straight from the .env file on disk. Returns {} if the
 * file can't be read. Called live (not cached) so a cookie refresh in .env is
 * picked up on the next request without restarting the process.
 */
export function readEnvFile(): Record<string, string> {
  try {
    const out: Record<string, string> = {};
    for (const raw of readFileSync(ENV_PATH, "utf8").split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq === -1) continue;
      const key = line.slice(0, eq).trim();
      let val = line.slice(eq + 1).trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      out[key] = val;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Merge-write keys into the .env file, preserving existing comments, ordering,
 * and untouched keys. Keys present in `updates` are replaced in place; new keys
 * are appended. Used by the web app's Settings screen.
 */
export function writeEnvFile(updates: Record<string, string>): void {
  let lines: string[] = [];
  try {
    lines = readFileSync(ENV_PATH, "utf8").split(/\r?\n/);
  } catch {
    lines = [];
  }
  const remaining = new Map(Object.entries(updates));
  const out = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return line;
    const eq = trimmed.indexOf("=");
    if (eq === -1) return line;
    const key = trimmed.slice(0, eq).trim();
    if (remaining.has(key)) {
      const val = remaining.get(key)!;
      remaining.delete(key);
      return `${key}=${val}`;
    }
    return line;
  });
  for (const [key, val] of remaining) out.push(`${key}=${val}`);
  // Trailing newline, no duplicate blank lines at EOF.
  while (out.length && out[out.length - 1] === "") out.pop();
  writeFileSync(ENV_PATH, out.join("\n") + "\n", "utf8");
}

// ---------------------------------------------------------------------------
// Config resolution
// ---------------------------------------------------------------------------
function envFirst(name: string): string {
  const v = process.env[name];
  if (v !== undefined && v !== "") return v.trim();
  return (readEnvFile()[name] ?? "").trim();
}

function clampInt(raw: string | undefined, dflt: number, min: number, max: number): number {
  const n = raw ? parseInt(raw, 10) : NaN;
  if (Number.isNaN(n)) return dflt;
  return Math.max(min, Math.min(max, n));
}

// Stable config (resolved once at import; changing these needs a restart).
export const BASE_URL = envFirst("CREATIO_BASE_URL").replace(/\/+$/, "");
export const ALLOWED_ENTITIES = envFirst("CREATIO_ALLOWED_ENTITIES")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
export const MAX_TOP = clampInt(envFirst("CREATIO_MAX_TOP") || undefined, 50, 1, 500);

// FileService entities the download proxy may fetch (case/feed/email attachments).
// Kept tight so the proxy can't be pointed at arbitrary file records.
export const FILE_DOWNLOAD_ENTITIES = ["CaseFile", "FeedFile", "ActivityFile"];

/**
 * Resolve the three SSO cookies, preferring the .env FILE on disk over
 * process.env — so refreshing .env (and nothing else) always takes effect, even
 * if the MCP client's registration baked in stale cookie values. Normalization
 * mirrors the accepted paste formats (bare value or `Name=value`).
 */
export function resolveCookieEnv(): { aspx: string; csrf: string; loader: string } {
  const file = readEnvFile();
  const pick = (name: string) => (file[name] ?? process.env[name] ?? "").trim();
  return {
    aspx: pick("CREATIO_ASPXAUTH").replace(/^\.?ASPXAUTH=/i, ""),
    csrf: pick("CREATIO_BPMCSRF").replace(/^BPMCSRF=/i, ""),
    loader: pick("CREATIO_BPMLOADER").replace(/^BPMLOADER=/i, ""),
  };
}

const INITIAL_COOKIES = resolveCookieEnv();
export const COOKIE_MODE = Boolean(INITIAL_COOKIES.aspx && INITIAL_COOKIES.csrf);

// Forms auth is only used when NOT in cookie mode.
const LOGIN = envFirst("CREATIO_LOGIN");
const PASSWORD = envFirst("CREATIO_PASSWORD");

export function assertEntityAllowed(entity: string): void {
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(entity)) {
    throw new Error(`Invalid entity name: ${entity}`);
  }
  if (ALLOWED_ENTITIES.length > 0 && !ALLOWED_ENTITIES.includes(entity)) {
    throw new Error(
      `Entity "${entity}" is not in the allowlist (${ALLOWED_ENTITIES.join(", ")}). ` +
        `Edit CREATIO_ALLOWED_ENTITIES to permit it.`
    );
  }
}

// ---------------------------------------------------------------------------
// Auth + HTTP (GET only)
// ---------------------------------------------------------------------------
let cookieJar = new Map<string, string>();
let bpmcsrf = "";
// What seedCookiesFromEnv() last read from disk — used to detect a .env refresh.
let lastSeededAspx = "";
let lastSeededCsrf = "";

function cookieHeader(): string {
  return [...cookieJar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

function storeSetCookies(res: Response): void {
  // Node 18.14+ / undici: getSetCookie() returns all Set-Cookie values.
  const raw = (res.headers as any).getSetCookie?.() as string[] | undefined;
  const list = raw ?? (res.headers.get("set-cookie") ? [res.headers.get("set-cookie")!] : []);
  for (const line of list) {
    const first = line.split(";")[0];
    const eq = first.indexOf("=");
    if (eq === -1) continue;
    const name = first.slice(0, eq).trim();
    const value = first.slice(eq + 1).trim();
    cookieJar.set(name, value);
    if (name === "BPMCSRF") bpmcsrf = value;
  }
}

/** Seed the cookie jar from the .env file (SSO cookie mode), reading the
 *  freshest values from disk on every call so a refresh is picked up live. */
export function seedCookiesFromEnv(): void {
  const { aspx, csrf, loader } = resolveCookieEnv();
  cookieJar = new Map();
  cookieJar.set(".ASPXAUTH", aspx);
  cookieJar.set("BPMCSRF", csrf);
  if (loader) cookieJar.set("BPMLOADER", loader);
  bpmcsrf = csrf;
  lastSeededAspx = aspx;
  lastSeededCsrf = csrf;
}

/** Thrown when SSO cookies are missing/expired. Consumers can special-case it
 *  (the web app maps it to an "open Settings" banner). */
export class AuthError extends Error {}

export async function login(): Promise<void> {
  if (!BASE_URL) {
    throw new Error("Creatio base URL is not configured (CREATIO_BASE_URL). Set it in Settings / .env.");
  }

  // Cookie mode can't re-authenticate against Creatio (the cookies came from a
  // browser session), but the cookies live in .env — so on expiry we re-read the
  // file: if you've refreshed it, we pick up the new cookies and carry on; if
  // it's unchanged, we report the clear error. No restart needed either way.
  if (COOKIE_MODE) {
    const fresh = resolveCookieEnv();
    const changed = fresh.aspx !== lastSeededAspx || fresh.csrf !== lastSeededCsrf;
    if (bpmcsrf && !changed) {
      throw new AuthError(
        "Creatio session cookies have expired. Grab fresh .ASPXAUTH / BPMCSRF / BPMLOADER " +
          "from your browser (DevTools → Application → Cookies) and update your .env. " +
          "The server re-reads .env automatically — no restart needed."
      );
    }
    seedCookiesFromEnv();
    return;
  }

  cookieJar = new Map();
  bpmcsrf = "";
  const res = await fetch(`${BASE_URL}/ServiceModel/AuthService.svc/Login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ UserName: LOGIN, UserPassword: PASSWORD }),
  });
  storeSetCookies(res);
  const body = (await res.json().catch(() => ({}))) as { Code?: number; Message?: string };
  if (!res.ok || (body.Code !== undefined && body.Code !== 0)) {
    throw new Error(`Creatio login failed (Code=${body.Code}): ${body.Message ?? res.statusText}`);
  }
  if (!bpmcsrf) throw new Error("Creatio login succeeded but no BPMCSRF cookie was returned.");
}

/**
 * Flatten Creatio's nested OData error envelope into one readable line.
 *
 * The raw body is
 *   {"error":{"message":"An error has occurred.","innererror":{"message":"...",
 *    "internalexception":{"message":"<the actual cause>"}}}}
 * — the generic outer text is useless, and the real reason sits at the bottom.
 * Walk to the innermost non-empty message; fall back to the raw text if the
 * body isn't the shape we expect (HTML error page, empty 500, etc.).
 */
function odataErrorMessage(text: string): string {
  let msg = "";
  try {
    let node = JSON.parse(text)?.error;
    while (node && typeof node === "object") {
      if (typeof node.message === "string" && node.message.trim()) msg = node.message.trim();
      node = node.innererror ?? node.internalexception;
    }
  } catch {
    // Not JSON — fall through to the raw body.
  }
  if (!msg) return text.slice(0, 500) || "(empty response body)";

  // The all-columns serialization failure (Creatio's published EDM model listing
  // a column the runtime record doesn't have) is the one 500 we hit repeatedly,
  // and the fix is always the same — say so instead of making the next person
  // rediscover it. See districtIndex.ts CASE_EXPAND for the $expand variant.
  if (/failed to serialize the response body|missing the property/i.test(msg)) {
    msg += " — this Creatio entity cannot be read with all columns; pass an explicit $select.";
  }
  return msg;
}

/** The ONLY network call path. Method is hard-coded to GET. */
export async function odataGet(path: string): Promise<any> {
  if (!bpmcsrf) await login();

  const doFetch = () =>
    fetch(`${BASE_URL}/0/odata/${path}`, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Cookie: cookieHeader(),
        BPMCSRF: bpmcsrf,
        ForceUseSession: "true",
      },
    });

  let res = await doFetch();
  if (res.status === 401 || res.status === 403) {
    await login(); // session expired — re-auth (or re-read refreshed cookies) once and retry
    res = await doFetch();
  }

  const text = await res.text();
  if (res.status === 401 || res.status === 403) {
    throw new AuthError(
      "Creatio rejected the session (HTTP " +
        res.status +
        "). The cookies are expired or invalid — update them in Settings / .env."
    );
  }
  if (!res.ok) {
    // No res.statusText: undici leaves it empty on HTTP/2 (no reason phrase).
    throw new Error(`OData GET /${path} -> ${res.status}: ${odataErrorMessage(text)}`);
  }
  return text ? JSON.parse(text) : {};
}

/** Download an attachment (read-only GET) from Creatio's FileService, e.g.
 *  /0/rest/FileService/Download/CaseFile/<guid>. Restricted to the file-entity
 *  allowlist + a GUID id so it can't be aimed at arbitrary paths. */
export async function downloadFile(
  entity: string,
  id: string
): Promise<{ buffer: Buffer; contentType: string; filename?: string }> {
  if (!FILE_DOWNLOAD_ENTITIES.includes(entity)) {
    throw new Error(`File entity "${entity}" is not downloadable.`);
  }
  if (!/^[0-9a-fA-F-]{36}$/.test(id)) throw new Error(`Invalid file id: ${id}`);
  if (!BASE_URL) throw new Error("Creatio base URL is not configured.");
  if (!bpmcsrf) await login();

  const url = `${BASE_URL}/0/rest/FileService/Download/${entity}/${id}`;
  const doFetch = () =>
    fetch(url, {
      method: "GET",
      headers: { Accept: "*/*", Cookie: cookieHeader(), BPMCSRF: bpmcsrf, ForceUseSession: "true" },
    });

  let res = await doFetch();
  if (res.status === 401 || res.status === 403) {
    await login();
    res = await doFetch();
  }
  if (res.status === 401 || res.status === 403) {
    throw new AuthError(`Creatio rejected the session (HTTP ${res.status}) while downloading a file.`);
  }
  if (!res.ok) {
    throw new Error(`File download ${entity}/${id} -> ${res.status} ${res.statusText}`);
  }
  const contentType = res.headers.get("content-type") || "application/octet-stream";
  const cd = res.headers.get("content-disposition") || "";
  const filename = (cd.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i) || [])[1];
  const buffer = Buffer.from(await res.arrayBuffer());
  return { buffer, contentType, filename };
}

// ---------------------------------------------------------------------------
// OData query builder (read-only)
// ---------------------------------------------------------------------------
export function buildQuery(opts: {
  select?: string[];
  filter?: string;
  orderby?: string;
  top?: number;
  expand?: string;
}): string {
  const p = new URLSearchParams();
  if (opts.select?.length) p.set("$select", opts.select.join(","));
  if (opts.filter) p.set("$filter", opts.filter);
  if (opts.orderby) p.set("$orderby", opts.orderby);
  if (opts.expand) p.set("$expand", opts.expand);
  p.set("$top", String(clampInt(String(opts.top ?? MAX_TOP), MAX_TOP, 1, MAX_TOP)));
  const s = p.toString();
  return s ? `?${s}` : "";
}

/** Convenience: query an entity set with the standard options. Returns the
 *  OData `value` array (or [] if absent). */
export async function queryRecords(
  entity: string,
  opts: { select?: string[]; filter?: string; orderby?: string; top?: number; expand?: string } = {}
): Promise<any[]> {
  assertEntityAllowed(entity);
  const data = await odataGet(entity + buildQuery(opts));
  return (data && data.value) || [];
}

// ---------------------------------------------------------------------------
// Bulk paging (app-authored queries only)
// ---------------------------------------------------------------------------
// MAX_TOP exists to stop a *model-driven* query from dragging back the whole
// table, and buildQuery() enforces it for every MCP/UI-facing path. Bulk
// indexing has the opposite need: it is app-authored, the page size is a
// constant in our own source, and 50-row pages would turn a 185-request build
// into a 3,700-request one. So it gets its own builder with a higher ceiling
// rather than loosening the guardrail everyone else goes through.
//
// This is still GET-only via odataGet(), so the read-only-by-construction
// property of the module is unchanged.

/** Page size ceiling for app-authored bulk reads. Verified server-side: $top=1000
 *  returns 1000 rows in ~1.4s. */
export const MAX_PAGE_TOP = 1000;

export interface PageOptions {
  select?: string[];
  filter?: string;
  orderby?: string;
  top?: number;
  skip?: number;
  expand?: string;
  /** Ask Creatio for the total matching row count (`@odata.count` on the response). */
  count?: boolean;
}

/** buildQuery's bulk sibling: honours $skip/$count and clamps to MAX_PAGE_TOP. */
export function buildPageQuery(opts: PageOptions): string {
  const p = new URLSearchParams();
  if (opts.select?.length) p.set("$select", opts.select.join(","));
  if (opts.filter) p.set("$filter", opts.filter);
  if (opts.orderby) p.set("$orderby", opts.orderby);
  if (opts.expand) p.set("$expand", opts.expand);
  if (opts.skip && opts.skip > 0) p.set("$skip", String(Math.floor(opts.skip)));
  if (opts.count) p.set("$count", "true");
  p.set(
    "$top",
    String(clampInt(String(opts.top ?? MAX_PAGE_TOP), MAX_PAGE_TOP, 1, MAX_PAGE_TOP))
  );
  const s = p.toString();
  return s ? `?${s}` : "";
}

/** One bulk page. Returns the rows plus the server total when `count` was set. */
export async function pageRecords(
  entity: string,
  opts: PageOptions = {}
): Promise<{ rows: any[]; total?: number }> {
  assertEntityAllowed(entity);
  const data = await odataGet(entity + buildPageQuery(opts));
  const total = data && typeof data["@odata.count"] === "number" ? data["@odata.count"] : undefined;
  return { rows: (data && data.value) || [], total };
}

/** Row count only, via `$count=true&$top=1`. Creatio's `/$count` endpoint returns
 *  non-JSON, so it is not usable through odataGet(). */
export async function countRecords(entity: string, filter?: string): Promise<number> {
  const { total } = await pageRecords(entity, { select: ["Id"], filter, top: 1, count: true });
  return total ?? 0;
}

/** Lightweight auth/connectivity check — reads 1 row of the first allowed
 *  entity (or Contact). Returns {ok:true} or {ok:false, error}. */
export async function testConnection(): Promise<{ ok: boolean; error?: string }> {
  const entity = ALLOWED_ENTITIES[0] || "Contact";
  try {
    // $select=Id, never an all-columns read: Creatio 500s serializing entities
    // whose published EDM model advertises a column the runtime record doesn't
    // have (Case/NltAdditionalInformation, and Contact likewise on this tenant),
    // and an all-columns Account read is slow enough to time out. Id exists on
    // every entity, so this probes auth and nothing else.
    await odataGet(entity + buildQuery({ select: ["Id"], top: 1 }));
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
