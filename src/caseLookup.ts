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
 *  - Feed/email AUTHORS DO resolve: SocialMessage.CreatedById is a *Contact* Id
 *    (NOT a SysAdminUnit Id, which is what the old note assumed), so one batched
 *    Contact read names every poster. Email senders resolve by matching
 *    Activity.Sender against Contact.Email. Never infer an author from an
 *    @mention in the body — that is still a guess and has been wrong.
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
}

export interface FindResult {
  cases: CaseRow[];
  truncated: boolean;
  caveats: string[];
}

const CASE_EXPAND =
  "Status($select=Name),Owner($select=Name),Account($select=Name),Contact($select=Name)";
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
  | { type: "list"; ordered: boolean; items: string[] }
  | { type: "image"; entity: string; id: string }
  | { type: "image"; dataUri: string };

/**
 * Sentinels wrapping an @mention's display name inside segment text.
 *
 * Private-use code points, so they cannot collide with real case text, and they
 * pass through HTML-escaping untouched. The UI escapes first and swaps them for
 * a chip afterwards, which keeps the "no raw Creatio HTML reaches the DOM"
 * guarantee. Keep these in sync with public/app.js.
 */
export const MENTION_OPEN = "\uE000";
export const MENTION_CLOSE = "\uE001";

/**
 * Sentinels wrapping a hyperlink inside segment text: OPEN url SEP label CLOSE.
 *
 * Same trick as mentions — the UI escapes first, then swaps these for an <a>.
 * Only http(s)/mailto URLs are ever wrapped. Keep in sync with public/app.js.
 */
export const LINK_OPEN = "";
export const LINK_SEP = "";
export const LINK_CLOSE = "";
const LINK_RE = new RegExp(`${LINK_OPEN}([^${LINK_SEP}]*)${LINK_SEP}([^${LINK_CLOSE}]*)${LINK_CLOSE}`, "g");

/** Flatten mention and link sentinels to plain text, for text-only consumers.
 *  A link keeps its URL ("label <url>") so an AI reader can still see it. */
export function plainMentions(s: string): string {
  return s
    .split(MENTION_OPEN).join("@").split(MENTION_CLOSE).join("")
    .replace(LINK_RE, (_m, url: string, label: string) => {
      const bare = url.replace(/^mailto:/i, "");
      return !label || label === url || label === bare ? bare : `${label} <${url}>`;
    });
}

/**
 * Resolve an <a href> to a URL safe to show, or null to drop the link.
 *
 * Outlook SafeLinks wrappers are unwrapped to the real target — the wrapper is
 * long, tracks the click, and hides where the file actually lives (e.g. the
 * FTP mock-up PDFs customers link from their request emails).
 */
function safeHref(raw: string): string | null {
  let href = decodeEntities(raw).trim();
  try {
    const u = new URL(href);
    if (/\.safelinks\.protection\.outlook\.com$/i.test(u.hostname)) {
      const inner = u.searchParams.get("url");
      if (inner) href = inner;
    }
  } catch {
    return null; // relative or malformed
  }
  return /^(https?:\/\/|mailto:)[^\s-]+$/i.test(href) ? href : null;
}

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
  const src = (html || "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    // A mention is an <a> wrapping an avatar <span> whose text is the person's
    // first initial. Tokenized verbatim that reads "NNolan Kelliher", so replace
    // the whole anchor with just its display name, between mention sentinels.
    .replace(
      /<a[^>]*data-mention-display-value="([^"]*)"[^>]*>[\s\S]*?<\/a>/gi,
      (_m, name: string) => MENTION_OPEN + name + MENTION_CLOSE
    )
    // Keep ordinary hyperlinks (tags inside the label are dropped). An unsafe
    // or relative href falls through, leaving just the label text.
    .replace(
      /<a\b[^>]*?\bhref\s*=\s*"([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi,
      (m, href: string, inner: string) => {
        const url = safeHref(href);
        if (!url) return m;
        const label = inner.replace(/<[^>]+>/g, "").replace(/[-]/g, "").trim();
        return LINK_OPEN + url + LINK_SEP + label + LINK_CLOSE;
      }
    );

  const segs: Segment[] = [];
  let buf = "";
  // Non-null while inside <ul>/<ol>, so each <li> becomes its own item instead
  // of running together into one paragraph.
  let list: { ordered: boolean; items: string[] } | null = null;

  /**
   * Drain the buffer as one normalized block.
   *
   * Creatio pretty-prints its HTML, so block tags and <li> arrive wrapped in
   * literal tabs and newlines. Left alone those survive into the UI as a ragged
   * indent. Normalize per line — NBSP to a plain space, inner runs collapsed,
   * and whitespace that only came from source formatting dropped — so every
   * block starts at the same left edge.
   */
  const take = (): string => {
    const t = decodeEntities(buf)
      .replace(/\u00A0/g, " ")
      // Zero-width junk Creatio's editor leaves behind, mostly around mentions.
      .replace(/[\u200B-\u200D\uFEFF]/g, "")
      .replace(/\r\n?/g, "\n")
      .split("\n")
      .map((line) => line.replace(/[ \t]{2,}/g, " ").trim())
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    buf = "";
    return t;
  };
  const flushText = () => {
    const t = take();
    if (t) segs.push({ type: "text", text: t });
  };
  const flushItem = () => {
    const t = take();
    if (t && list) list.items.push(t);
  };
  const closeList = () => {
    if (!list) return;
    flushItem();
    if (list.items.length) segs.push({ type: "list", ordered: list.ordered, items: list.items });
    list = null;
  };

  const re =
    /<img\b[^>]*>|<(?:ul|ol)\b[^>]*>|<\/(?:ul|ol)>|<li\b[^>]*>|<\/li>|<\/(?:div|p|tr|h[1-6])>|<br\s*\/?>|<[^>]+>|[^<]+/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const tok = m[0];
    if (/^<img/i.test(tok)) {
      const s = (tok.match(/src\s*=\s*"([^"]*)"/i) || [])[1] || "";
      const fs = s.match(FILE_SRC_RE);
      const emit = (seg: Segment) => {
        if (list) flushItem();
        else flushText();
        segs.push(seg);
      };
      if (fs && ALLOWED_FILE_ENTITIES.includes(fs[1])) {
        emit({ type: "image", entity: fs[1], id: fs[2] });
      } else if (/^data:image\/(png|jpe?g|gif|webp|bmp);base64,/i.test(s)) {
        emit({ type: "image", dataUri: s });
      }
      // else: drop (cid:, external tracking, unknown)
    } else if (/^<(?:ul|ol)\b/i.test(tok)) {
      // A nested list just continues as a flat one — good enough for case text,
      // and far less fragile than tracking depth.
      closeList();
      flushText();
      list = { ordered: /^<ol/i.test(tok), items: [] };
    } else if (/^<\/(?:ul|ol)>$/i.test(tok)) {
      closeList();
    } else if (/^<li\b/i.test(tok) || /^<\/li>$/i.test(tok)) {
      if (list) flushItem();
      else buf += "\n";
    } else if (/^<\/(?:div|p|tr|h[1-6])>$/i.test(tok) || /^<br/i.test(tok)) {
      buf += "\n";
    } else if (/^<[^>]+>$/.test(tok)) {
      /* other tag: ignore */
    } else {
      buf += tok;
    }
  }
  closeList();
  flushText();
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
  /** Who posted, resolved to a Contact name. Left undefined when it could not
   *  be resolved — the UI says "Unknown author" rather than showing a GUID. */
  author?: string;
  /** The Contact Id behind `author`, so the UI can mark your own posts. */
  authorId?: string;
}

const EMPTY_GUID = "00000000-0000-0000-0000-000000000000";
/** OR-chains get long fast, and an over-long filter is what makes Creatio 500. */
const CONTACT_BATCH = 20;

/** Pull the bare address out of "Name <a@b.c>" or a raw address. */
function emailAddress(v: string | null | undefined): string {
  return ((v || "").match(/[\w.+-]+@[\w-]+\.[\w.-]+/) || [""])[0].toLowerCase();
}

/**
 * Batched Contact lookups, keyed by whichever column was matched.
 *
 * Best-effort by design: naming a poster is a nicety, so a failed read (Contact
 * missing from the allowlist, an expired cookie) yields an empty map and the
 * timeline still renders — it just says "Unknown author".
 */
async function contactMap(
  values: (string | null | undefined)[],
  clause: (v: string) => string,
  key: "Id" | "Email"
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const unique = [...new Set(values.filter((v): v is string => !!v && v !== EMPTY_GUID))];
  for (let i = 0; i < unique.length; i += CONTACT_BATCH) {
    const chunk = unique.slice(i, i + CONTACT_BATCH);
    try {
      const rows = await queryRecords("Contact", {
        filter: chunk.map(clause).join(" or "),
        select: ["Id", "Name", "Email"],
        top: chunk.length,
      });
      for (const r of rows) {
        const k = String(r[key] ?? "").toLowerCase();
        if (k && r.Name) out.set(k, r.Name);
      }
    } catch {
      /* leave this chunk unresolved */
    }
  }
  return out;
}

export async function getTimeline(caseId: string, caseNumber: string): Promise<TimelineEntry[]> {
  // Feed posts, linked by EntityId = the Case Id.
  const feed = await queryRecords("SocialMessage", {
    filter: `EntityId eq ${caseId}`,
    select: ["Id", "Message", "CreatedOn", "CreatedById"],
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

  // Name the posters. CreatedById is a Contact Id, so the whole feed resolves in
  // one batched read; email senders are matched on their address.
  const byId = await contactMap(
    feed.map((f) => f.CreatedById),
    (id) => `Id eq ${id}`,
    "Id"
  );
  const byEmail = await contactMap(
    mail.map((m) => emailAddress(m.Sender)),
    (e) => `Email eq '${odataLit(e)}'`,
    "Email"
  );

  const entries: TimelineEntry[] = [
    ...feed.map((f) => ({
      kind: "FEED" as const,
      ts: f.CreatedOn,
      text: strip(f.Message),
      segments: htmlToSegments(f.Message), // clean rich text: render inline (incl. FeedFile images)
      authorId: f.CreatedById,
      author: byId.get(String(f.CreatedById || "").toLowerCase()),
    })),
    ...mail.map((m) => ({
      kind: "EMAIL" as const,
      ts: m.CreatedOn,
      title: m.Title,
      sender: m.Sender,
      recipient: m.Recepient, // note: Creatio's field is misspelled "Recepient"
      // Fall back to the raw address — it still tells you who wrote.
      author: byEmail.get(emailAddress(m.Sender)) || m.Sender || undefined,
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

export interface CaseAttachment {
  id: string;
  name: string;
  size: number;
  createdOn: string;
}

/**
 * Files on the case's Attachments tab.
 *
 * Goes through queryRecords, so the entity allowlist still applies: `CaseFile`
 * must be in CREATIO_ALLOWED_ENTITIES or this throws. Only metadata is read —
 * the bytes are served separately by the existing read-only /api/file proxy,
 * which already permits CaseFile.
 *
 * `Case/Id eq <guid>` is the navigation path; the guid is NOT quoted, and
 * filtering on a `CaseId` column would fail the same way it does elsewhere.
 */
export async function getAttachments(caseId: string): Promise<CaseAttachment[]> {
  const rows = await queryRecords("CaseFile", {
    select: ["Id", "Name", "Size", "CreatedOn"],
    filter: `Case/Id eq ${caseId}`,
    orderby: "CreatedOn desc",
    top: 25,
  });
  return rows.map((r: any) => ({
    id: r.Id,
    name: r.Name || "",
    size: Number(r.Size) || 0,
    createdOn: r.CreatedOn || "",
  }));
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
// Detail: Case info (Creatio's left-hand "Case info" panel)
// ---------------------------------------------------------------------------
export interface CaseInfoField {
  label: string;
  value: string;
  /** Creatio renders these as links (blue); the rest are plain values. */
  link?: boolean;
  required?: boolean;
  date?: boolean;
}

/**
 * The panel's fields, in Creatio's order, as one read. Column names were
 * verified against live records (a wrong name in $select/$expand fails the
 * whole query). SIS District code and Institution ID live on the Account, not
 * the Case — Creatio's panel pulls them through the Account lookup.
 */
const CASE_INFO_QUERY =
  "$select=Id,SolutionDate,NltSchoolCode" +
  "&$expand=Contact($select=Name),Account($select=Name,NltDistrictCode,NltInstNum)," +
  "Priority($select=Name),Category($select=Name),ServiceItem($select=Name)," +
  "NltServiceArea($select=Name),NltCaseType($select=Name)";

export async function getCaseInfo(caseId: string): Promise<CaseInfoField[]> {
  const r = (await odataGet(`Case(${caseId})?${CASE_INFO_QUERY}`)) || {};
  const s = (v: unknown) => (v == null ? "" : String(v));
  return [
    { label: "Contact", value: s(r.Contact?.Name), link: true },
    { label: "Account", value: s(r.Account?.Name), link: true, required: true },
    { label: "Priority", value: s(r.Priority?.Name), link: true },
    { label: "Category", value: s(r.Category?.Name) },
    { label: "Service", value: s(r.ServiceItem?.Name), link: true, required: true },
    { label: "Service Area", value: s(r.NltServiceArea?.Name), required: true },
    { label: "Case Type", value: s(r.NltCaseType?.Name) },
    { label: "Resolution time", value: s(r.SolutionDate), date: true },
    { label: "SIS District code", value: s(r.Account?.NltDistrictCode) },
    { label: "School Code", value: s(r.NltSchoolCode) },
    { label: "Institution ID Number", value: s(r.Account?.NltInstNum) },
  ];
}

// ---------------------------------------------------------------------------
// Orchestration: fetch requested detail for a set of cases
// ---------------------------------------------------------------------------
export type DetailKind = "summary" | "description" | "timeline" | "latest" | "extra" | "caseinfo";

export interface CaseDetail {
  description?: string; // plain text (AI context / fallback)
  descriptionSegments?: Segment[]; // ordered text + inline images (UI)
  timeline?: TimelineEntry[];
  latest?: TimelineEntry | null;
  extra?: ExtraFields;
  caseInfo?: CaseInfoField[];
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
  if (want.has("caseinfo")) out.caseInfo = await getCaseInfo(c.Id);

  return out;
}
