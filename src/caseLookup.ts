/**
 * Case-lookup domain logic — the read-only query recipes behind the web app,
 * ported from the /creatio-case-lookup skill and CASE-QUERY-REFERENCE.md.
 *
 * Everything here goes through the shared read-only client (queryRecords /
 * odataGet), so it is GET-only like the rest of the project.
 *
 * Hard-won gotchas encoded below:
 *  - Filter through navigation paths (Owner/Id, Account/Id, Status/Name), NEVER
 *    the FK columns (OwnerId/AccountId/StatusId) — those return HTTP 500.
 *  - Activity has no queryable CaseId — link emails to a case by matching the
 *    case number in the Title (contains(Title,'SR...')).
 *  - Feed/email AUTHORS do not resolve over this OData access — leave unresolved
 *    and never infer from @mentions.
 */

import { MAX_TOP, odataGet, buildQuery, queryRecords, FILE_DOWNLOAD_ENTITIES } from "./creatioClient.js";

// ---------------------------------------------------------------------------
// HTML helpers (verbatim from CASE-QUERY-REFERENCE.md)
// ---------------------------------------------------------------------------
export function strip(h: string | null | undefined): string {
  return (h || "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<a[^>]*data-mention-display-value="([^"]*)"[^>]*>.*?<\/a>/gs, "@$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&#39;|&rsquo;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&quot;|&ldquo;|&rdquo;/g, '"')
    .replace(/&mdash;/g, "-")
    .replace(/v\\?:\*|o\\?:\*|w\\?:\*|\.shape|\{behavior:url\(#default#VML\);\}/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function trimReply(t: string): string {
  return t
    .split(/From:\s|On .{5,40} wrote:|Caution: This Message is From an External Sender/)[0]
    .trim();
}

/** Escape a single quote for an OData string literal. */
function odataLit(v: string): string {
  return v.replace(/'/g, "''");
}

// ---------------------------------------------------------------------------
// Status handling
// ---------------------------------------------------------------------------
// Canonical Creatio case statuses the UI offers. "Open / active" is a group.
export const STATUS_NAMES = [
  "New",
  "In progress",
  "Waiting for response",
  "Resolved",
  "Closed",
  "Canceled",
] as const;

export const OPEN_ACTIVE = ["New", "In progress", "Waiting for response", "Resolved"];

/** Build an OData filter fragment for a set of status names (via Status/Name). */
function statusFilter(statuses: string[]): string | null {
  const names = statuses.filter((s) => (STATUS_NAMES as readonly string[]).includes(s));
  if (!names.length) return null;
  return "(" + names.map((n) => `Status/Name eq '${odataLit(n)}'`).join(" or ") + ")";
}

// ---------------------------------------------------------------------------
// Resolvers (name -> GUIDs), for the disambiguation picker
// ---------------------------------------------------------------------------
export interface Candidate {
  Id: string;
  Name: string;
}

export async function resolveOwner(name: string): Promise<Candidate[]> {
  const rows = await queryRecords("Contact", {
    filter: `contains(Name,'${odataLit(name)}')`,
    select: ["Id", "Name"],
    orderby: "Name",
    top: MAX_TOP,
  });
  return rows.map((r) => ({ Id: r.Id, Name: r.Name }));
}

export async function resolveAccount(name: string): Promise<Candidate[]> {
  const rows = await queryRecords("Account", {
    filter: `contains(Name,'${odataLit(name)}')`,
    select: ["Id", "Name"],
    orderby: "Name",
    top: MAX_TOP,
  });
  return rows.map((r) => ({ Id: r.Id, Name: r.Name }));
}

// ---------------------------------------------------------------------------
// Case search
// ---------------------------------------------------------------------------
export type SelectMode = "owner" | "account" | "number" | "recent";

export interface CaseRow {
  Id: string;
  Number: string;
  Subject: string;
  CreatedOn: string;
  Status: string;
  Owner: string;
  Account: string;
  Contact: string;
  /** SIS district code off the account (Account.NltDistrictCode), "" if none. */
  District: string;
}

export interface FindResult {
  cases: CaseRow[];
  truncated: boolean;
  caveats: string[];
}

// NltDistrictCode rides along on the Account expand — same field the district
// index uses, so the Lookup tab and the Districts tab always agree. Do NOT add
// ParentId / NltRegionId to the Account $select: both 500 from inside an
// $expand (see districtIndex.ts).
const CASE_EXPAND =
  "Status($select=Name),Owner($select=Name),Account($select=Name,NltDistrictCode),Contact($select=Name)";
const CASE_SELECT = ["Id", "Number", "Subject", "CreatedOn"];

function shapeCase(r: any): CaseRow {
  return {
    Id: r.Id,
    Number: r.Number,
    Subject: r.Subject,
    CreatedOn: r.CreatedOn,
    Status: r.Status?.Name ?? "",
    Owner: r.Owner?.Name ?? "",
    Account: r.Account?.Name ?? "",
    Contact: r.Contact?.Name ?? "",
    // Trim as well as uppercase — the district registry stores codes trimmed,
    // and a stray space would break the join to the Districts tab.
    District: String(r.Account?.NltDistrictCode || "").trim().toUpperCase(),
  };
}

export interface FindOptions {
  mode: SelectMode;
  /** For 'owner'/'account': the chosen GUIDs. For 'number': the SR numbers. */
  guids?: string[];
  numbers?: string[];
  statuses?: string[];
  /** Page further back: only return cases created before this ISO timestamp. */
  before?: string;
}

export async function findCases(opts: FindOptions): Promise<FindResult> {
  const caveats: string[] = [];
  const clauses: string[] = [];

  if (opts.mode === "owner") {
    const guids = (opts.guids || []).filter(Boolean);
    if (!guids.length) throw new Error("No owner selected.");
    clauses.push("(" + guids.map((g) => `Owner/Id eq ${g}`).join(" or ") + ")");
  } else if (opts.mode === "account") {
    const guids = (opts.guids || []).filter(Boolean);
    if (!guids.length) throw new Error("No account selected.");
    clauses.push("(" + guids.map((g) => `Account/Id eq ${g}`).join(" or ") + ")");
  } else if (opts.mode === "number") {
    const nums = (opts.numbers || []).map((n) => n.trim()).filter(Boolean);
    if (!nums.length) throw new Error("No case number provided.");
    clauses.push("(" + nums.map((n) => `Number eq '${odataLit(n)}'`).join(" or ") + ")");
  } // 'recent' => no selector clause

  // Status filter (skip for 'number' lookups — you want the case regardless).
  if (opts.mode !== "number") {
    const sf = statusFilter(opts.statuses || []);
    if (sf) clauses.push(sf);
  }

  if (opts.before) clauses.push(`CreatedOn lt ${opts.before}`);

  const filter = clauses.length ? clauses.join(" and ") : undefined;
  const rows = await queryRecords("Case", {
    filter,
    expand: CASE_EXPAND,
    select: CASE_SELECT,
    orderby: "CreatedOn desc",
    top: MAX_TOP,
  });

  const cases = rows.map(shapeCase);
  const truncated = cases.length >= MAX_TOP;
  if (truncated) {
    caveats.push(
      `Result hit the ${MAX_TOP}-row cap — there may be more. Use "load older" to page further back.`
    );
  }
  return { cases, truncated, caveats };
}

// ---------------------------------------------------------------------------
// Detail: description, timeline
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Attachments / inline images
// ---------------------------------------------------------------------------
// FileService entities we surface. Everything else (cid:, external tracking
// pixels, arbitrary paths) is dropped. Shared with the download proxy.
const ALLOWED_FILE_ENTITIES = FILE_DOWNLOAD_ENTITIES;

const FILE_SRC_RE = /\/0\/rest\/FileService\/Download\/([A-Za-z]+)\/([0-9a-fA-F-]{36})/;

export interface CaseImage {
  entity: string;
  id: string;
}

/** A rendering segment: escaped text (with newlines) or an image reference.
 *  The UI escapes text and only emits <img> for these whitelisted sources, so
 *  no raw Creatio HTML ever reaches the DOM (no XSS surface). */
export type Segment =
  | { type: "text"; text: string }
  | { type: "image"; entity: string; id: string }
  | { type: "image"; dataUri: string };

/** Decode the handful of entities strip() handles, but KEEP newlines. */
function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&#39;|&rsquo;/g, "'")
    .replace(/&quot;|&ldquo;|&rdquo;/g, '"')
    .replace(/&mdash;/g, "-")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** Turn Creatio rich-text HTML into ordered text/image segments. Block tags
 *  and <br> become newlines; whitelisted FileService images and data: images
 *  become image segments (in place); all other tags are dropped. */
export function htmlToSegments(html: string | null | undefined): Segment[] {
  const src = (html || "").replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<!--[\s\S]*?-->/g, "");
  const segs: Segment[] = [];
  let buf = "";
  const flush = () => {
    const t = decodeEntities(buf).replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").replace(/[ \t]{2,}/g, " ").trim();
    if (t) segs.push({ type: "text", text: t });
    buf = "";
  };
  const re = /<img\b[^>]*>|<\/(?:div|p|li|tr|h[1-6])>|<br\s*\/?>|<[^>]+>|[^<]+/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const tok = m[0];
    if (/^<img/i.test(tok)) {
      const s = (tok.match(/src\s*=\s*"([^"]*)"/i) || [])[1] || "";
      const fs = s.match(FILE_SRC_RE);
      if (fs && ALLOWED_FILE_ENTITIES.includes(fs[1])) {
        flush();
        segs.push({ type: "image", entity: fs[1], id: fs[2] });
      } else if (/^data:image\/(png|jpe?g|gif|webp|bmp);base64,/i.test(s)) {
        flush();
        segs.push({ type: "image", dataUri: s });
      }
      // else: drop (cid:, external tracking, unknown)
    } else if (/^<\/(?:div|p|li|tr|h[1-6])>$/i.test(tok) || /^<br/i.test(tok)) {
      buf += "\n";
    } else if (/^<[^>]+>$/.test(tok)) {
      /* other tag: ignore */
    } else {
      buf += tok;
    }
  }
  flush();
  return segs;
}

/** Extract only real file attachments (whitelisted FileService) from HTML,
 *  ignoring inline data:/cid:/external noise. Deduped, order-preserving. */
export function extractFileImages(html: string | null | undefined): CaseImage[] {
  const out: CaseImage[] = [];
  const seen = new Set<string>();
  for (const tag of (html || "").match(/<img\b[^>]*>/gi) || []) {
    const s = (tag.match(/src\s*=\s*"([^"]*)"/i) || [])[1] || "";
    const fs = s.match(FILE_SRC_RE);
    if (fs && ALLOWED_FILE_ENTITIES.includes(fs[1]) && !seen.has(fs[2])) {
      seen.add(fs[2]);
      out.push({ entity: fs[1], id: fs[2] });
    }
  }
  return out;
}

/** A file deliberately attached to the case (the Attachments tab in Creatio),
 *  as opposed to an image embedded inline in a feed post or email. */
export interface CaseFileRow {
  Id: string;
  Name: string;
  Size?: number;
  CreatedOn?: string;
}

export async function listCaseFiles(caseId: string): Promise<CaseFileRow[]> {
  const rows = await queryRecords("CaseFile", {
    filter: `Case/Id eq ${caseId}`,
    select: ["Id", "Name", "Size", "CreatedOn"],
    orderby: "CreatedOn asc",
    top: MAX_TOP,
  });
  return rows
    .filter((r) => /^[0-9a-fA-F-]{36}$/.test(r?.Id || ""))
    .map((r) => ({ Id: r.Id, Name: String(r.Name || ""), Size: r.Size, CreatedOn: r.CreatedOn }));
}

export interface Description {
  text: string; // plain text (for AI context / fallback)
  segments: Segment[]; // ordered text + inline images (for the UI)
}

export async function getDescription(caseId: string): Promise<Description> {
  const data = await odataGet(`Case(${caseId})?$select=Symptoms`);
  const html = data?.Symptoms || "";
  return { text: strip(html), segments: htmlToSegments(html) };
}

export interface TimelineEntry {
  kind: "FEED" | "EMAIL";
  ts: string;
  text: string;
  // Feed: inline rich-text segments (may include images).
  segments?: Segment[];
  // Email: real file attachments (screenshots), shown as thumbnails.
  images?: CaseImage[];
  // Email-only metadata:
  title?: string;
  sender?: string;
  recipient?: string;
}

export async function getTimeline(caseId: string, caseNumber: string): Promise<TimelineEntry[]> {
  // Feed posts, linked by EntityId = the Case Id.
  const feed = await queryRecords("SocialMessage", {
    filter: `EntityId eq ${caseId}`,
    select: ["Id", "Message", "CreatedOn"],
    orderby: "CreatedOn asc",
    top: MAX_TOP,
  });

  // Emails, linked by the case number stamped into the Title (no queryable CaseId).
  const mail = await queryRecords("Activity", {
    filter: `contains(Title,'${odataLit(caseNumber)}')`,
    select: ["Id", "Title", "CreatedOn", "Sender", "Recepient", "SendDate", "Body"],
    orderby: "CreatedOn asc",
    top: MAX_TOP,
  });

  const entries: TimelineEntry[] = [
    ...feed.map((f) => ({
      kind: "FEED" as const,
      ts: f.CreatedOn,
      text: strip(f.Message),
      segments: htmlToSegments(f.Message), // clean rich text: render inline (incl. FeedFile images)
    })),
    ...mail.map((m) => ({
      kind: "EMAIL" as const,
      ts: m.CreatedOn,
      title: m.Title,
      sender: m.Sender,
      recipient: m.Recepient, // note: Creatio's field is misspelled "Recepient"
      text: trimReply(strip(m.Body)),
      images: extractFileImages(m.Body), // only real attachments; skip signature/tracking noise
    })),
  ];
  entries.sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());
  return entries;
}

// ---------------------------------------------------------------------------
// Detail: extra fields
// ---------------------------------------------------------------------------
export interface ExtraFields {
  RegisteredOn?: string;
  ModifiedOn?: string;
  ResponseDate?: string;
  SolutionDate?: string;
  SolutionOverdue?: boolean;
  NltHoursWorked?: number;
}

export async function getExtraFields(caseId: string): Promise<ExtraFields> {
  const data = await odataGet(
    `Case(${caseId})?$select=RegisteredOn,ModifiedOn,ResponseDate,SolutionDate,SolutionOverdue,NltHoursWorked`
  );
  return {
    RegisteredOn: data?.RegisteredOn,
    ModifiedOn: data?.ModifiedOn,
    ResponseDate: data?.ResponseDate,
    SolutionDate: data?.SolutionDate,
    SolutionOverdue: data?.SolutionOverdue,
    NltHoursWorked: data?.NltHoursWorked,
  };
}

// ---------------------------------------------------------------------------
// Orchestration: fetch requested detail for a set of cases
// ---------------------------------------------------------------------------
export type DetailKind = "summary" | "description" | "timeline" | "latest" | "extra";

export interface CaseDetail {
  description?: string; // plain text (AI context / fallback)
  descriptionSegments?: Segment[]; // ordered text + inline images (UI)
  timeline?: TimelineEntry[];
  latest?: TimelineEntry | null;
  extra?: ExtraFields;
}

/** Fetch the requested detail kinds for one case. `summary` needs no extra call. */
export async function getCaseDetail(
  c: CaseRow,
  detail: DetailKind[]
): Promise<CaseDetail> {
  const out: CaseDetail = {};
  const want = new Set(detail);

  if (want.has("description")) {
    const d = await getDescription(c.Id);
    out.description = d.text;
    out.descriptionSegments = d.segments;
  }

  if (want.has("timeline") || want.has("latest")) {
    const tl = await getTimeline(c.Id, c.Number);
    if (want.has("timeline")) out.timeline = tl;
    if (want.has("latest")) out.latest = tl.length ? tl[tl.length - 1] : null;
  }

  if (want.has("extra")) out.extra = await getExtraFields(c.Id);

  return out;
}
