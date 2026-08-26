/**
 * District case index — groups Creatio cases by SIS district code so a ticket's
 * history can be searched per district.
 *
 * THE KEY FIELD: `Account.NltDistrictCode`. Verified live against the tenant:
 * 2,400 accounts carry it, 2,196 distinct codes, and the values are the SAME
 * codes as the custom-reports district folders (`HCA-CO`, `SMA-NC`,
 * `MILWAUKEE-DIO`). Cases reach it through their Account, and it is filterable
 * via the navigation path `Account/NltDistrictCode`.
 *
 * Do NOT use `Case.NltSchoolCode` / `Case.NltMidNumber`: both exist on the
 * entity but were empty on every recent case sampled. The Account is the source
 * of truth.
 *
 * WHY AN INDEX. Creatio can filter by district on demand, but the questions this
 * feature exists to answer are cross-district ("which districts are noisy?",
 * "has anyone reported this before?") and text-based. Both need the whole window
 * in memory. So one bulk pass builds a local index; per-case detail
 * (descriptions, timelines, attachments) is still fetched live on demand.
 *
 * Read-only: every call goes through pageRecords() -> odataGet(), whose HTTP
 * method is hard-coded to GET.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { pageRecords, MAX_PAGE_TOP } from "./creatioClient.js";
import { strip } from "./caseLookup.js";

const TOOL_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const CACHE_DIR = join(TOOL_DIR, ".cache");
const CACHE_FILE = join(CACHE_DIR, "district-cases.json");
const CACHE_VERSION = 1;

/**
 * How far back the history goes. Two years covers the realistic "has this
 * district reported this before?" window, including the previous school year —
 * which is what you actually want for an annual report-card issue.
 * Widening this is a one-line change; the next build backfills the difference.
 */
export const HISTORY_SINCE = "2024-01-01T00:00:00Z";

/** Registry refresh interval. District codes change rarely. */
const REGISTRY_TTL_MS = 24 * 60 * 60 * 1000;

/** Flush the partial index to disk every N pages, so a 6-minute build that dies
 *  on an expired cookie doesn't throw away the pages it already paid for. */
const FLUSH_EVERY_PAGES = 20;

/** Label for cases we could not attribute to any district. Not a real code — the
 *  `-- ` prefix cannot collide with one (codes are alphanumeric + hyphen). */
export const NO_DISTRICT = "-- no district --";

/**
 * Mirrors DISTRICT_CODE_RE in repoIndex.ts:58 (AA-CA, HCA-CAN, SA-GUAM). Kept as
 * a local copy so this module stays independent of the filesystem index — it is
 * only a cheap pre-filter anyway: a scanned token must ALSO already exist in the
 * registry before it is accepted, so the regex can never invent a district.
 */
const DISTRICT_CODE_RE = /^[A-Za-z][A-Za-z0-9]{1,7}(-[A-Za-z0-9]{2,5})+$/;

// ---------------------------------------------------------------------------
// Statuses
// ---------------------------------------------------------------------------
// The tenant has 28 case statuses (CaseStatus is queryable, despite what the
// older docs in this repo claim). caseLookup.ts hardcodes 6 of them and its
// statusFilter() silently drops the rest, which is why nothing here reuses that
// list: statuses are stored as the raw string Creatio returned, and the UI's
// filter options are derived from what the index actually contains.
//
// "Open" is therefore defined by exclusion — anything not terminal is open. A
// status this code has never seen counts as open, which is the safe default
// (a ticket wrongly shown as open gets noticed; one wrongly hidden does not).
const TERMINAL_STATUSES = new Set(
  [
    "closed",
    "canceled",
    "cancelled",
    "canceledinvalid",
    "cancellednoworkdone",
    "canceled - invalid",
    "completed",
    "workcomplete",
    "solved",
    "deployed",
  ].map(normStatus)
);

function normStatus(s: string): string {
  return s.toLowerCase().replace(/[^a-z]/g, "");
}

/** True if this status name means the ticket is still live. `Resolved` counts as
 *  open, matching the existing app's "open / active" grouping. */
export function isOpenStatus(status: string): boolean {
  return !TERMINAL_STATUSES.has(normStatus(status || ""));
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Where a row's district code came from. Never conflate inferred with authoritative. */
export type CodeSource = "account" | "subject" | "description";

export interface DistrictAccount {
  id: string;
  name: string;
}

export interface DistrictCaseRow {
  id: string;
  number: string;
  subject: string;
  createdOn: string;
  status: string;
  owner: string;
  accountId: string;
  accountName: string;
  /** Resolved district code, UPPERCASE, or null if unattributed. */
  code: string | null;
  source: CodeSource | null;
}

export interface DistrictSummary {
  code: string;
  accounts: DistrictAccount[];
  total: number;
  open: number;
  /** CreatedOn of the newest case, or "" when the district has none in window. */
  lastActivity: string;
}

export interface DistrictIndex {
  builtAt: number;
  registryBuiltAt: number;
  since: string;
  /** Newest CreatedOn indexed — the forward cursor for incremental refresh. */
  watermark: string;
  /** Oldest CreatedOn indexed; null once the backfill has reached `since`. */
  backfillCursor: string | null;
  /** True when the full window is present. */
  complete: boolean;
  /** Code -> accounts. 65 codes are shared by more than one account (dioceses,
   *  multi-campus districts), so this is deliberately a list. */
  registry: Map<string, DistrictAccount[]>;
  /** accountId -> code, the authoritative resolution path. */
  accountCode: Map<string, string>;
  /** caseId -> row. A Map makes page-boundary duplicates a non-issue. */
  cases: Map<string, DistrictCaseRow>;
}

export interface BuildProgress {
  (p: {
    phase: "registry" | "forward" | "backfill" | "saving";
    fetched: number;
    total?: number;
    pct?: number;
    message?: string;
  }): void;
}

let cached: DistrictIndex | null = null;

// ---------------------------------------------------------------------------
// The scanner — recover a code from case text
// ---------------------------------------------------------------------------

/**
 * Tokens shaped exactly like a district code that never are one. Locale and
 * charset tags are the dangerous ones because some of them collide with real
 * registry codes — `EN-US` is an actual district code in this tenant, and a
 * naive scan promoted cases whose description merely linked to a
 * `.../en-US/...` support page. A district legitimately coded `EN-CA` or `FR-CA`
 * would be missed by the text path; it still resolves correctly through its
 * Account, which is the authoritative route anyway.
 */
const CODE_STOPWORDS = new Set([
  "EN-US", "EN-GB", "EN-CA", "EN-AU", "EN-NZ", "EN-IE", "EN-ZA", "EN-IN",
  "FR-CA", "FR-FR", "ES-US", "ES-ES", "ES-MX", "PT-BR", "DE-DE", "ZH-CN",
  "UTF-8", "UTF-16", "ISO-8859", "X-NONE", "MS-OFFICE", "CONTENT-TYPE",
  "WINDOWS-1252", "TIMES-NEW", "SANS-SERIF", "E-MAIL", "FOLLOW-UP",
]);

/**
 * Bump when the scanning heuristics change. Stored in the cache; on load, a
 * mismatch re-applies the text heuristics locally (no network) and drops
 * description-derived codes so they get re-scanned with the current rules.
 */
const SCANNER_VERSION = 2;

/**
 * Find the first known district code mentioned in `text`.
 *
 * Only ever returns a code that already exists in `registry`, so it cannot
 * invent a district: the regex narrows candidate tokens, the registry decides.
 * Case Subjects embed their own district code often ("SMA-NC - Custom GPA
 * Report"), which is what makes this a worthwhile recovery path for cases whose
 * Account carries no code.
 *
 * Two guards keep it honest:
 *  - CODE_STOPWORDS, for shapes that are never districts.
 *  - a context check, because the same characters mean something else inside a
 *    URL or an attribute value. `/en-US/` and `lang=en-US` are not districts;
 *    a code delimited by whitespace, punctuation or a line start is.
 */
export function scanForCode(text: string, registry: Map<string, unknown>): string | null {
  if (!text) return null;
  const re = /[A-Za-z][A-Za-z0-9]{1,7}(?:-[A-Za-z0-9]{2,5})+/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const token = m[0];
    if (token.length < 4 || !DISTRICT_CODE_RE.test(token)) continue;

    const upper = token.toUpperCase();
    if (CODE_STOPWORDS.has(upper)) continue;

    // Reject anything embedded in a path, URL, filename or attribute value.
    const before = m.index > 0 ? text[m.index - 1] : " ";
    const after = m.index + token.length < text.length ? text[m.index + token.length] : " ";
    if ("/\\=\"'.?&@_:".includes(before)) continue;
    if ("/\\=@_".includes(after)) continue;

    if (registry.has(upper)) return upper;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

const CASE_SELECT = ["Id", "Number", "Subject", "CreatedOn", "AccountId"];

/**
 * Verified-safe expand. Do NOT add `ParentId` or `NltRegionId` to the Account
 * select: either one makes Creatio return HTTP 500 ("failed to serialize the
 * response body") from inside an $expand, though both are fine in a direct
 * Account query.
 */
const CASE_EXPAND =
  "Status($select=Name),Owner($select=Name),Account($select=Name,NltDistrictCode)";

function shapeRow(r: any, index: DistrictIndex): DistrictCaseRow {
  const accountId: string = r.AccountId && !isNilGuid(r.AccountId) ? r.AccountId : "";
  const accountName: string = r.Account?.Name ?? "";
  const subject: string = r.Subject ?? "";

  // Precedence: authoritative account field, then the subject text.
  // The description scan is on-demand only (see resolveFromDescriptions).
  let code: string | null = null;
  let source: CodeSource | null = null;

  const fromAccount: string | undefined =
    r.Account?.NltDistrictCode || (accountId ? index.accountCode.get(accountId) : undefined);
  if (fromAccount) {
    // Trim as well as uppercase — the registry pass trims, and a code with stray
    // whitespace would otherwise become a second, near-duplicate district.
    code = String(fromAccount).trim().toUpperCase();
    source = "account";
  } else {
    const scanned = scanForCode(subject, index.registry);
    if (scanned) {
      code = scanned;
      source = "subject";
    }
  }

  return {
    id: r.Id,
    number: r.Number ?? "",
    subject,
    createdOn: r.CreatedOn ?? "",
    status: r.Status?.Name ?? "",
    owner: r.Owner?.Name ?? "",
    accountId,
    accountName,
    code,
    source,
  };
}

function isNilGuid(g: string): boolean {
  return !g || g === "00000000-0000-0000-0000-000000000000";
}

function emptyIndex(): DistrictIndex {
  return {
    builtAt: 0,
    registryBuiltAt: 0,
    since: HISTORY_SINCE,
    watermark: "",
    backfillCursor: null,
    complete: false,
    registry: new Map(),
    accountCode: new Map(),
    cases: new Map(),
  };
}

/**
 * Pass 1 — the district registry. ~3 requests for 2,400 accounts.
 *
 * Includes every code, even ones with no cases in the window: knowing a district
 * exists in Creatio but has filed nothing is itself an answer.
 */
async function buildRegistry(ix: DistrictIndex, onProgress?: BuildProgress): Promise<void> {
  const registry = new Map<string, DistrictAccount[]>();
  const accountCode = new Map<string, string>();

  let skip = 0;
  for (;;) {
    const { rows } = await pageRecords("Account", {
      select: ["Id", "Name", "NltDistrictCode"],
      filter: "NltDistrictCode ne null",
      orderby: "Id",
      top: MAX_PAGE_TOP,
      skip,
    });
    for (const r of rows) {
      const code = String(r.NltDistrictCode || "").trim().toUpperCase();
      if (!code) continue;
      const account: DistrictAccount = { id: r.Id, name: r.Name ?? "" };
      const list = registry.get(code);
      if (list) list.push(account);
      else registry.set(code, [account]);
      accountCode.set(r.Id, code);
    }
    skip += rows.length;
    onProgress?.({ phase: "registry", fetched: skip, message: `${registry.size} district codes` });
    if (rows.length < MAX_PAGE_TOP) break;
  }

  ix.registry = registry;
  ix.accountCode = accountCode;
  ix.registryBuiltAt = Date.now();
}

/**
 * Fetch one keyset page of cases, newest-first.
 *
 * Keyset (a moving `CreatedOn` cursor) rather than `$skip`, because $skip gets
 * progressively more expensive server-side across 184k rows. Verified lossless:
 * 3 pages -> 3000/3000 distinct ids. Ties straddling a page boundary are
 * harmless because rows land in a Map keyed by case id.
 */
async function fetchCasePage(
  bounds: { after?: string; before?: string; beforeStrict?: boolean },
  since: string
): Promise<any[]> {
  const clauses = [`CreatedOn ge ${since}`];
  if (bounds.before) {
    // `le` by default so a group of cases sharing one timestamp can't be split
    // across the page boundary and lost; duplicates are free because rows land
    // in a Map. `lt` is used only to break out of an all-duplicates page.
    clauses.push(`CreatedOn ${bounds.beforeStrict ? "lt" : "le"} ${bounds.before}`);
  }
  if (bounds.after) clauses.push(`CreatedOn gt ${bounds.after}`);
  const { rows } = await pageRecords("Case", {
    select: CASE_SELECT,
    expand: CASE_EXPAND,
    filter: clauses.join(" and "),
    orderby: "CreatedOn desc",
    top: MAX_PAGE_TOP,
  });
  return rows;
}

/**
 * Build or advance the index.
 *
 * Three phases, all resumable:
 *   registry  — refreshed when stale or forced
 *   forward   — anything created since `watermark` (seconds on a warm index)
 *   backfill  — walk back toward `since`; the expensive first-run phase
 *
 * The initial 2-year build is ~185 pages at ~2s each (about 6-7 minutes). It is
 * newest-first and flushed periodically, so the index is useful long before it
 * finishes and an interrupted run resumes where it stopped rather than starting
 * over. An expired SSO cookie mid-build surfaces as AuthError with the partial
 * index already saved.
 */
export async function buildDistrictIndex(
  opts: { force?: boolean; maxPages?: number } = {},
  onProgress?: BuildProgress
): Promise<DistrictIndex> {
  const ix = opts.force ? emptyIndex() : (cached ?? (await loadCache()) ?? emptyIndex());
  cached = ix;

  if (ix.since !== HISTORY_SINCE) {
    // The window was widened in source — keep the rows, reopen the backfill.
    ix.since = HISTORY_SINCE;
    ix.complete = false;
  }

  if (!ix.registry.size || Date.now() - ix.registryBuiltAt > REGISTRY_TTL_MS) {
    await buildRegistry(ix, onProgress);
  }

  const maxPages = opts.maxPages ?? Infinity;
  let pages = 0;
  let fetched = 0;
  let dirty = false;

  const flush = async () => {
    if (!dirty) return;
    ix.builtAt = Date.now();
    await saveCache(ix).catch(() => {
      /* cache is an optimization; never fatal */
    });
    dirty = false;
  };

  try {
    // ---- forward: catch up on everything newer than the watermark ----------
    // Walk DOWN from newest toward the old watermark, which stays fixed as the
    // lower bound for the whole pass.
    if (ix.watermark) {
      const lowerBound = ix.watermark;
      let newWatermark = ix.watermark;
      let before: string | undefined;
      let beforeStrict = false;

      for (;;) {
        if (pages >= maxPages) break;
        const rows = await fetchCasePage({ after: lowerBound, before, beforeStrict }, ix.since);
        pages++;
        if (!rows.length) break;

        const added = ingestPage(ix, rows);
        fetched += rows.length;
        dirty = true;
        if (rows[0].CreatedOn > newWatermark) newWatermark = rows[0].CreatedOn;
        onProgress?.({ phase: "forward", fetched, message: `${ix.cases.size} cases indexed` });

        if (rows.length < MAX_PAGE_TOP) break;
        before = rows[rows.length - 1].CreatedOn;
        beforeStrict = added === 0;
      }
      ix.watermark = newWatermark;
    }

    // ---- backfill: walk back toward `since` --------------------------------
    if (!ix.complete) {
      let before = ix.backfillCursor ?? undefined;
      let beforeStrict = false;

      for (;;) {
        if (pages >= maxPages) break;
        const rows = await fetchCasePage({ before, beforeStrict }, ix.since);
        pages++;
        if (!rows.length) {
          ix.complete = true;
          ix.backfillCursor = null;
          dirty = true;
          break;
        }

        const added = ingestPage(ix, rows);
        fetched += rows.length;
        dirty = true;

        const newest = rows[0].CreatedOn;
        if (!ix.watermark || newest > ix.watermark) ix.watermark = newest;
        before = rows[rows.length - 1].CreatedOn;
        beforeStrict = added === 0;
        ix.backfillCursor = before ?? null;

        onProgress?.({
          phase: "backfill",
          fetched,
          message: `${ix.cases.size} cases indexed, back to ${String(before).slice(0, 10)}`,
        });

        if (rows.length < MAX_PAGE_TOP) {
          ix.complete = true;
          ix.backfillCursor = null;
          break;
        }
        if (pages % FLUSH_EVERY_PAGES === 0) await flush();
      }
    }
  } catch (e) {
    // Save what we have before surfacing the failure — a mid-build cookie
    // expiry should cost the remaining pages, not the completed ones. The
    // backfill cursor is already persisted, so the next run resumes here.
    await flush();
    throw e;
  }

  onProgress?.({ phase: "saving", fetched, message: "writing cache" });
  ix.builtAt = Date.now();
  dirty = true;
  await flush();
  return ix;
}

/** Ingest a page; returns how many rows were NOT already indexed. A page that
 *  adds nothing means the keyset cursor is stuck on a timestamp tie. */
function ingestPage(ix: DistrictIndex, rows: any[]): number {
  let added = 0;
  for (const raw of rows) {
    if (!raw?.Id) continue;
    const existing = ix.cases.get(raw.Id);
    if (!existing) added++;
    const row = shapeRow(raw, ix);
    // Never let a re-ingest downgrade a code a description scan already promoted.
    if (existing?.source === "description" && !row.code) {
      row.code = existing.code;
      row.source = existing.source;
    }
    ix.cases.set(row.id, row);
  }
  return added;
}

/** True when the index has nothing usable yet. */
export function isEmpty(ix: DistrictIndex | null): boolean {
  return !ix || ix.cases.size === 0;
}

/**
 * Re-apply the text heuristics to an existing index, in memory, no network.
 *
 * Runs automatically when a cache was written by an older SCANNER_VERSION. The
 * authoritative `account` codes are untouched; `subject` codes are re-derived
 * with the current rules; `description` codes are cleared, because re-deriving
 * them needs the HTML back — they get picked up again by the next on-demand scan.
 *
 * This exists so tightening the scanner costs a second of local work instead of
 * a full multi-minute re-page of Creatio.
 */
export function reapplyTextHeuristics(ix: DistrictIndex): {
  cleared: number;
  rederived: number;
} {
  let cleared = 0;
  let rederived = 0;
  for (const row of ix.cases.values()) {
    if (row.source === "account") continue;
    if (row.source === "description") {
      row.code = null;
      row.source = null;
      cleared++;
      continue;
    }
    const had = row.code;
    const found = scanForCode(row.subject, ix.registry);
    row.code = found;
    row.source = found ? "subject" : null;
    if (had !== found) {
      if (had && !found) cleared++;
      else rederived++;
    }
  }
  return { cleared, rederived };
}

/** Load from memory/disk without hitting the network. Null if never built. */
export async function peekDistrictIndex(): Promise<DistrictIndex | null> {
  if (cached) return cached;
  const disk = await loadCache();
  if (disk) cached = disk;
  return disk;
}

/** The index, building it if there is nothing cached at all. */
export async function getDistrictIndex(onProgress?: BuildProgress): Promise<DistrictIndex> {
  const have = await peekDistrictIndex();
  if (have && have.cases.size) return have;
  return buildDistrictIndex({}, onProgress);
}

// ---------------------------------------------------------------------------
// On-demand description scan
// ---------------------------------------------------------------------------

/**
 * Last-resort resolution for unattributed cases: fetch `Symptoms` and scan it.
 *
 * Deliberately NOT part of the bulk build — 184k HTML descriptions is not a
 * fetch anyone should make. This runs for the cases actually on screen (the
 * "no district" bucket, a page at a time) and persists what it finds, so the
 * index improves as it gets used.
 */
export async function resolveFromDescriptions(
  ix: DistrictIndex,
  caseIds: string[],
  onProgress?: (done: number, total: number, promoted: number) => void
): Promise<{ promoted: number; scanned: number }> {
  const targets = caseIds.filter((id) => {
    const row = ix.cases.get(id);
    return row && !row.code;
  });

  let promoted = 0;
  let scanned = 0;

  // Batched by id so one request covers many cases.
  //
  // BATCH is capped by Creatio's OData expression limit, not by us: an
  // `Id eq X or Id eq Y or …` chain of 20 is rejected with "The node count
  // limit of '100' has been exceeded", and 15 is the measured ceiling. The v4
  // `in (…)` operator, which would sidestep this, is not supported by this
  // tenant. 12 leaves headroom.
  const BATCH = 12;
  for (let i = 0; i < targets.length; i += BATCH) {
    const batch = targets.slice(i, i + BATCH);
    const filter = "(" + batch.map((id) => `Id eq ${id}`).join(" or ") + ")";
    const { rows } = await pageRecords("Case", {
      select: ["Id", "Symptoms"],
      filter,
      top: BATCH,
    });
    for (const r of rows) {
      scanned++;
      const row = ix.cases.get(r.Id);
      if (!row || row.code) continue;
      const text = strip(String(r.Symptoms || ""));
      const code = scanForCode(text, ix.registry);
      if (code) {
        row.code = code;
        row.source = "description";
        promoted++;
      }
    }
    onProgress?.(Math.min(i + BATCH, targets.length), targets.length, promoted);
  }

  if (promoted) {
    await saveCache(ix).catch(() => {
      /* non-fatal */
    });
  }
  return { promoted, scanned };
}

// ---------------------------------------------------------------------------
// Queries over the index (no network)
// ---------------------------------------------------------------------------

/**
 * code -> rows, newest first. Rebuilt on every call, deliberately: over 184k
 * rows / 8.7k codes this measures ~50ms, so a full district list plus one
 * district's history is ~85ms. Memoizing it would buy nothing a local user can
 * perceive and would need invalidating on every ingest and every on-demand code
 * promotion. Don't add a cache here without a measurement that justifies it.
 */
function groupByCode(ix: DistrictIndex): Map<string, DistrictCaseRow[]> {
  const groups = new Map<string, DistrictCaseRow[]>();
  for (const row of ix.cases.values()) {
    const key = row.code ?? NO_DISTRICT;
    const list = groups.get(key);
    if (list) list.push(row);
    else groups.set(key, [row]);
  }
  for (const list of groups.values()) list.sort(byNewest);
  return groups;
}

function byNewest(a: DistrictCaseRow, b: DistrictCaseRow): number {
  return a.createdOn < b.createdOn ? 1 : a.createdOn > b.createdOn ? -1 : 0;
}

/** Every distinct status present in the index, for the UI's filter options. */
export function statusesPresent(ix: DistrictIndex): string[] {
  const set = new Set<string>();
  for (const row of ix.cases.values()) if (row.status) set.add(row.status);
  return [...set].sort();
}

/**
 * District list with counts. Districts with no cases in the window are included
 * (sorted last) so the registry stays visible. `search` matches the code or any
 * of the district's account names.
 */
export function listDistricts(
  ix: DistrictIndex,
  opts: { search?: string; limit?: number } = {}
): { districts: DistrictSummary[]; noDistrict: DistrictSummary; totalCodes: number } {
  const groups = groupByCode(ix);
  const needle = (opts.search || "").trim().toUpperCase();

  const scored: Array<{ rank: number; d: DistrictSummary }> = [];
  const codes = new Set<string>([...ix.registry.keys(), ...groups.keys()]);
  codes.delete(NO_DISTRICT);

  for (const code of codes) {
    const accounts = ix.registry.get(code) ?? [];

    // Rank so a search for "HCA" surfaces HCA-CO before CHCA-AL: exact, then
    // code prefix, then code substring, then account-name match.
    let rank = 0;
    if (needle) {
      if (code === needle) rank = 4;
      else if (code.startsWith(needle)) rank = 3;
      else if (code.includes(needle)) rank = 2;
      else if (accounts.some((a) => a.name.toUpperCase().includes(needle))) rank = 1;
      else continue;
    }

    const rows = groups.get(code) ?? [];
    scored.push({
      rank,
      d: {
        code,
        accounts,
        total: rows.length,
        open: rows.filter((r) => isOpenStatus(r.status)).length,
        lastActivity: rows.length ? rows[0].createdOn : "",
      },
    });
  }

  // Best match first; then most recently active. Districts with no cases in the
  // window fall to the bottom of their match tier rather than disappearing.
  scored.sort((x, y) => {
    if (x.rank !== y.rank) return y.rank - x.rank;
    const a = x.d;
    const b = y.d;
    if (!a.lastActivity && !b.lastActivity) return a.code < b.code ? -1 : 1;
    if (!a.lastActivity) return 1;
    if (!b.lastActivity) return -1;
    return a.lastActivity < b.lastActivity ? 1 : -1;
  });
  const out = scored.map((s) => s.d);

  const none = groups.get(NO_DISTRICT) ?? [];
  const noDistrict: DistrictSummary = {
    code: NO_DISTRICT,
    accounts: [],
    total: none.length,
    open: none.filter((r) => isOpenStatus(r.status)).length,
    lastActivity: none.length ? none[0].createdOn : "",
  };

  return {
    districts: opts.limit ? out.slice(0, opts.limit) : out,
    noDistrict,
    totalCodes: codes.size,
  };
}

export interface HistoryOptions {
  statuses?: string[];
  /** Free-text match over subject, number, account name and owner. */
  q?: string;
  limit?: number;
  /** Page further back: only rows created before this ISO timestamp. */
  before?: string;
}

/** One district's ticket history, newest first. Pass NO_DISTRICT for the bucket. */
export function districtHistory(
  ix: DistrictIndex,
  code: string,
  opts: HistoryOptions = {}
): { rows: DistrictCaseRow[]; total: number; truncated: boolean } {
  const key = code === NO_DISTRICT ? NO_DISTRICT : code.trim().toUpperCase();
  const all = (groupByCode(ix).get(key) ?? []).filter((r) => matches(r, opts));
  const limit = opts.limit ?? 200;
  const rows = all.slice(0, limit);
  return { rows, total: all.length, truncated: all.length > rows.length };
}

/** Cross-district text search, newest first. */
export function searchCases(
  ix: DistrictIndex,
  opts: HistoryOptions = {}
): { rows: DistrictCaseRow[]; total: number; truncated: boolean } {
  const all: DistrictCaseRow[] = [];
  for (const row of ix.cases.values()) if (matches(row, opts)) all.push(row);
  all.sort(byNewest);
  const limit = opts.limit ?? 200;
  const rows = all.slice(0, limit);
  return { rows, total: all.length, truncated: all.length > rows.length };
}

function matches(row: DistrictCaseRow, opts: HistoryOptions): boolean {
  if (opts.statuses?.length && !opts.statuses.includes(row.status)) return false;
  if (opts.before && !(row.createdOn < opts.before)) return false;
  const q = (opts.q || "").trim().toLowerCase();
  if (q) {
    const hay = `${row.subject} ${row.number} ${row.accountName} ${row.owner}`.toLowerCase();
    if (!hay.includes(q)) return false;
  }
  return true;
}

/** Look a case up by SR number (case-insensitive). */
export function caseByNumber(ix: DistrictIndex, number: string): DistrictCaseRow | null {
  const want = number.trim().toUpperCase();
  if (!want) return null;
  for (const row of ix.cases.values()) {
    if (row.number.toUpperCase() === want) return row;
  }
  return null;
}

/** Headline numbers for the UI banner. */
export function indexStats(ix: DistrictIndex): {
  builtAt: number;
  since: string;
  complete: boolean;
  backfillCursor: string | null;
  cases: number;
  codes: number;
  attributed: number;
  bySource: Record<string, number>;
} {
  let attributed = 0;
  const bySource: Record<string, number> = { account: 0, subject: 0, description: 0 };
  for (const row of ix.cases.values()) {
    if (row.code) {
      attributed++;
      if (row.source) bySource[row.source] = (bySource[row.source] ?? 0) + 1;
    }
  }
  return {
    builtAt: ix.builtAt,
    since: ix.since,
    complete: ix.complete,
    backfillCursor: ix.backfillCursor,
    cases: ix.cases.size,
    codes: ix.registry.size,
    attributed,
    bySource,
  };
}

// ---------------------------------------------------------------------------
// Disk cache
// ---------------------------------------------------------------------------
// Rows are stored as fixed-order arrays with interned status/owner/account/code
// dictionaries. 184k rows as plain objects is ~45 MB of mostly repeated key
// names and repeated account names; interned it lands around 15-20 MB.

const SOURCES: CodeSource[] = ["account", "subject", "description"];

type PackedRow = [
  string, // id
  string, // number
  string, // subject
  string, // createdOn
  number, // status index
  number, // owner index
  number, // account index (id + name), -1 = none
  number, // code index, -1 = none
  number // source index, -1 = none
];

interface CacheShape {
  v: number;
  /** SCANNER_VERSION the text-derived codes were produced with. */
  sv?: number;
  builtAt: number;
  registryBuiltAt: number;
  since: string;
  watermark: string;
  backfillCursor: string | null;
  complete: boolean;
  registry: Array<[string, DistrictAccount[]]>;
  dStatus: string[];
  dOwner: string[];
  dAccountId: string[];
  dAccountName: string[];
  dCode: string[];
  rows: PackedRow[];
}

/** Intern helper: value -> stable index into `list`. */
function interner(list: string[]): (v: string) => number {
  const seen = new Map<string, number>();
  return (v: string) => {
    if (!v) v = "";
    let i = seen.get(v);
    if (i === undefined) {
      i = list.length;
      list.push(v);
      seen.set(v, i);
    }
    return i;
  };
}

async function saveCache(ix: DistrictIndex): Promise<void> {
  await mkdir(CACHE_DIR, { recursive: true });

  const dStatus: string[] = [];
  const dOwner: string[] = [];
  const dAccountId: string[] = [];
  const dAccountName: string[] = [];
  const dCode: string[] = [];
  const iStatus = interner(dStatus);
  const iOwner = interner(dOwner);
  const iCode = interner(dCode);

  // Account id and name are interned together so one index yields both.
  const acctSeen = new Map<string, number>();
  const iAccount = (id: string, name: string): number => {
    if (!id) return -1;
    let i = acctSeen.get(id);
    if (i === undefined) {
      i = dAccountId.length;
      dAccountId.push(id);
      dAccountName.push(name);
      acctSeen.set(id, i);
    }
    return i;
  };

  const rows: PackedRow[] = [];
  for (const r of ix.cases.values()) {
    rows.push([
      r.id,
      r.number,
      r.subject,
      r.createdOn,
      iStatus(r.status),
      iOwner(r.owner),
      iAccount(r.accountId, r.accountName),
      r.code ? iCode(r.code) : -1,
      r.source ? SOURCES.indexOf(r.source) : -1,
    ]);
  }

  const shape: CacheShape = {
    v: CACHE_VERSION,
    sv: SCANNER_VERSION,
    builtAt: ix.builtAt,
    registryBuiltAt: ix.registryBuiltAt,
    since: ix.since,
    watermark: ix.watermark,
    backfillCursor: ix.backfillCursor,
    complete: ix.complete,
    registry: [...ix.registry.entries()],
    dStatus,
    dOwner,
    dAccountId,
    dAccountName,
    dCode,
    rows,
  };
  await writeFile(CACHE_FILE, JSON.stringify(shape), "utf8");
}

async function loadCache(): Promise<DistrictIndex | null> {
  try {
    const raw = await readFile(CACHE_FILE, "utf8");
    const shape = JSON.parse(raw) as CacheShape;
    if (!shape || shape.v !== CACHE_VERSION) return null;

    const registry = new Map<string, DistrictAccount[]>(shape.registry);
    const accountCode = new Map<string, string>();
    for (const [code, accounts] of registry) {
      for (const a of accounts) accountCode.set(a.id, code);
    }

    const cases = new Map<string, DistrictCaseRow>();
    for (const p of shape.rows) {
      const [id, number, subject, createdOn, si, oi, ai, ci, srci] = p;
      cases.set(id, {
        id,
        number,
        subject,
        createdOn,
        status: shape.dStatus[si] ?? "",
        owner: shape.dOwner[oi] ?? "",
        accountId: ai >= 0 ? shape.dAccountId[ai] ?? "" : "",
        accountName: ai >= 0 ? shape.dAccountName[ai] ?? "" : "",
        code: ci >= 0 ? shape.dCode[ci] ?? null : null,
        source: srci >= 0 ? SOURCES[srci] ?? null : null,
      });
    }

    const ix: DistrictIndex = {
      builtAt: shape.builtAt,
      registryBuiltAt: shape.registryBuiltAt,
      since: shape.since,
      watermark: shape.watermark,
      backfillCursor: shape.backfillCursor,
      complete: shape.complete,
      registry,
      accountCode,
      cases,
    };

    // Cache predates the current scanning rules — re-derive the text-based codes
    // locally rather than trusting stale heuristics or forcing a full re-page.
    if ((shape.sv ?? 0) !== SCANNER_VERSION) {
      const { cleared, rederived } = reapplyTextHeuristics(ix);
      console.error(
        `[district-index] scanner v${shape.sv ?? 0} -> v${SCANNER_VERSION}: ` +
          `${cleared} code(s) cleared, ${rederived} re-derived`
      );
      await saveCache(ix).catch(() => {
        /* non-fatal */
      });
    }

    return ix;
  } catch {
    return null;
  }
}
