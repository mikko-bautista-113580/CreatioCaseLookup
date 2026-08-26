#!/usr/bin/env node
/**
 * Local web app for the Creatio Case Lookup workflow.
 *
 * A tiny localhost-only HTTP server (Node built-ins only — no Express) that
 * serves the static UI from ../public and a small JSON API backed by the shared
 * read-only Creatio client. It is a single-user local tool: it binds to
 * 127.0.0.1 and the only thing it ever writes is the local .env (via Settings).
 * All Creatio access is read-only (GET) through creatioClient.
 */

import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { readFile, writeFile, rename } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, normalize, extname } from "node:path";
import { exec } from "node:child_process";

import {
  ALLOWED_ENTITIES,
  BASE_URL,
  MAX_TOP,
  AuthError,
  readEnvFile,
  writeEnvFile,
  resolveCookieEnv,
  seedCookiesFromEnv,
  testConnection,
  downloadFile,
  FILE_DOWNLOAD_ENTITIES,
} from "./creatioClient.js";
import { loginViaBrowser, LoginCancelledError } from "./browserLogin.js";
import {
  findCases,
  resolveOwner,
  resolveAccount,
  getCaseDetail,
  OPEN_ACTIVE,
  STATUS_NAMES,
  type CaseRow,
  type DetailKind,
  type FindResult,
  type SelectMode,
} from "./caseLookup.js";
import {
  analyzeCases,
  claudeAvailable,
  ANALYZE_PROMPTS,
  type AnalyzableCase,
  type Preset,
} from "./analyze.js";
import {
  buildIndex,
  toAbs,
  isKnownFile,
  districtForPath,
  REPO_ROOT,
  type RepoIndex,
} from "./repoIndex.js";
import { analyzeCaseSignals } from "./districtMap.js";
import { triageCase, TRIAGE_PROMPTS, type CaseBrief } from "./triage.js";
import {
  workOnCase,
  buildWorkScope,
  repoAvailable,
  gitBaseline,
  collectChanges,
  WORK_PROMPTS,
  MAX_HINT,
  planWorkOn,
  narrowPlanToStep,
  type WorkScope,
  type WorkPlan,
  type PlanStep,
  type GitBaseline,
} from "./workOn.js";
import { audit, newRunId } from "./audit.js";
import {
  loadFixes,
  saveFix,
  deleteFix,
  scanWorkingChanges,
  type FixRecord,
} from "./fixStore.js";
import { stageAttachments, type StagedAttachments } from "./attachments.js";
import { randomUUID } from "node:crypto";
import {
  buildDistrictIndex,
  peekDistrictIndex,
  listDistricts,
  districtHistory,
  searchCases,
  statusesPresent,
  indexStats,
  resolveFromDescriptions,
  HISTORY_SINCE,
  NO_DISTRICT,
} from "./districtIndex.js";

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public");
const PORT = parseInt(process.env.CREATIO_APP_PORT || "3000", 10);
const HOST = "127.0.0.1";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(text);
}

/** Map an error to a structured JSON response. AuthError -> {error:'auth'} so
 *  the UI can show an "open Settings" banner instead of a raw message. */
function sendError(res: ServerResponse, err: unknown): void {
  if (err instanceof AuthError) {
    sendJson(res, 401, { error: "auth", message: err.message });
    return;
  }
  const message = err instanceof Error ? err.message : String(err);
  sendJson(res, 500, { error: "server", message });
}

async function readBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("Invalid JSON body.");
  }
}

function mask(v: string): string {
  if (!v) return "";
  if (v.length <= 8) return "•".repeat(v.length);
  return v.slice(0, 4) + "•".repeat(Math.min(20, v.length - 8)) + v.slice(-4);
}

/** Parse a numeric query param, clamped. */
function clampParam(raw: string | null, dflt: number, min: number, max: number): number {
  const n = raw ? parseInt(raw, 10) : NaN;
  if (Number.isNaN(n)) return dflt;
  return Math.max(min, Math.min(max, n));
}

/** Shared filter options for the district history / search routes. */
function historyOptions(url: URL): {
  statuses?: string[];
  q?: string;
  limit: number;
  before?: string;
} {
  const statusesRaw = url.searchParams.get("statuses") || "";
  const statuses = statusesRaw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    statuses: statuses.length ? statuses : undefined,
    q: url.searchParams.get("q") || undefined,
    limit: clampParam(url.searchParams.get("limit"), 200, 1, 2000),
    before: url.searchParams.get("before") || undefined,
  };
}

function statusTally(rows: Array<{ status: string }>): Record<string, number> {
  const tally: Record<string, number> = {};
  for (const r of rows) tally[r.status] = (tally[r.status] || 0) + 1;
  return tally;
}

// ---------------------------------------------------------------------------
// Static file serving (path-traversal safe)
// ---------------------------------------------------------------------------
async function serveStatic(res: ServerResponse, urlPath: string): Promise<void> {
  const rel = urlPath === "/" ? "/index.html" : urlPath;
  const filePath = normalize(join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end("Forbidden");
    return;
  }
  try {
    const data = await readFile(filePath);
    const type = MIME[extname(filePath).toLowerCase()] || "application/octet-stream";
    // Read fresh from disk every request, and tell the browser not to cache:
    // editing public/* is meant to show up on a plain refresh, no restart and
    // no hard-reload needed. Nothing to lose — this is a localhost tool.
    res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store" }).end(data);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found");
  }
}

// ---------------------------------------------------------------------------
// API handlers
// ---------------------------------------------------------------------------
async function handleApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL
): Promise<void> {
  const path = url.pathname;

  // Static config the UI needs to render its controls.
  if (req.method === "GET" && path === "/api/meta") {
    const ai = claudeAvailable();
    sendJson(res, 200, {
      baseUrl: BASE_URL,
      allowlist: ALLOWED_ENTITIES,
      maxTop: MAX_TOP,
      statuses: STATUS_NAMES,
      openActive: OPEN_ACTIVE,
      aiAvailable: ai,
      workAvailable: ai && (await repoAvailable()),
      repoRoot: REPO_ROOT,
    });
    return;
  }

  // The exact instructions every AI run is given, verbatim from the source
  // constants — served so the developer can check what the AI is told without
  // reading the code. The guardrail notes describe the actual run options.
  if (req.method === "GET" && path === "/api/instructions") {
    sendJson(res, 200, {
      model: process.env.CREATIO_APP_MODEL || "(Claude CLI default)",
      stages: [
        {
          id: "analyze",
          title: "Analyze with AI",
          when: "Runs when you click a ✨ preset or ask a question on the Lookup tab.",
          guardrails: [
            "No tools, no MCP servers — the AI can only read what it is sent and write text back.",
            "Runs in an empty temp folder, so no CLAUDE.md or settings files load.",
            "Case data and your question are passed on stdin as data, never as instructions.",
          ],
          systemPrompt: ANALYZE_PROMPTS.systemPrompt,
          instructions: [
            { label: "Summarize & prioritize", text: ANALYZE_PROMPTS.presets.summarize },
            { label: "Common themes", text: ANALYZE_PROMPTS.presets.themes },
            { label: "Next actions", text: ANALYZE_PROMPTS.presets.actions },
            { label: "Ask a question", text: ANALYZE_PROMPTS.askInstruction },
          ],
        },
        {
          id: "triage",
          title: "Pipeline triage",
          when: "Runs once per case on the Pipeline tab, and as step 1 of Work on a case.",
          guardrails: [
            "No tools, no MCP servers, empty temp folder — it can describe the case but act on nothing.",
            "Case text goes in fenced as UNTRUSTED data with a per-run random marker.",
            "Your own instructions from the work-on box are passed as TRUSTED guidance outside that fence — they can change the report type and which files are picked, but not what files exist to pick from.",
            "Every file path and district code it returns is re-checked against the real repo index and the offered list; anything else is dropped and logged to the audit file.",
          ],
          systemPrompt: TRIAGE_PROMPTS.systemPrompt,
          instructions: [{ label: "Task", text: TRIAGE_PROMPTS.instruction }],
        },
        {
          id: "plan",
          title: "Plan the fix (read-only)",
          when: "Runs as step 2 of Work on a case, before the approve button — and again whenever you click Re-plan.",
          guardrails: [
            "Read/Grep/Glob only. Edit, Write, MultiEdit, Bash, web and subagents are all denied — this pass cannot change a file, so you see the intent before anything has hands.",
            "Same brief, same rules and same repo as the edit run, so the plan is made under the conditions the worker will actually face.",
            "Returns JSON that the app re-validates: every proposed path is re-typed and length-capped, and a step aiming outside the approved folders is flagged in the UI rather than quietly dropped.",
            "Whatever plan is on screen when you approve is handed to the edit run as its direction.",
          ],
          systemPrompt: WORK_PROMPTS.planSystemPrompt,
          instructions: [{ label: "Task", text: WORK_PROMPTS.planInstruction }],
        },
        {
          id: "work",
          title: "Work on a case (edit-capable)",
          when: "Runs only after you review the triage brief and the plan, then click approve.",
          guardrails: [
            "Never sees raw case text — only the validated brief, the plan you approved, your typed instructions, and staged image attachments.",
            "Your instructions are followed as direction, but cannot widen the edit scope or waive the hard rules below.",
            "Tools are limited to Read/Grep/Glob plus Edit/Write inside the approved district folders only; everything else is denied, not asked.",
            "No Bash, no web, no subagents — it cannot commit, push, or leave the repo.",
            "All edits stay as uncommitted working-tree changes for you to review.",
          ],
          systemPrompt: WORK_PROMPTS.systemPrompt,
          instructions: [{ label: "Task", text: WORK_PROMPTS.instruction }],
        },
      ],
    });
    return;
  }

  if (req.method === "GET" && path === "/api/test-auth") {
    const result = await testConnection();
    sendJson(res, 200, result);
    return;
  }

  // Resolve a name to candidate GUIDs for the disambiguation picker.
  if (req.method === "GET" && path === "/api/resolve") {
    const type = url.searchParams.get("type");
    const name = (url.searchParams.get("name") || "").trim();
    if (!name) return sendJson(res, 200, { candidates: [] });
    try {
      const candidates =
        type === "account" ? await resolveAccount(name) : await resolveOwner(name);
      sendJson(res, 200, { candidates });
    } catch (e) {
      sendError(res, e);
    }
    return;
  }

  // Main search: find cases + stream per-case detail with progress (SSE).
  if (req.method === "POST" && path === "/api/cases") {
    await handleCases(req, res);
    return;
  }

  // Attachment proxy — streams an image/file from Creatio's FileService.
  if (req.method === "GET" && path === "/api/file") {
    const entity = url.searchParams.get("entity") || "";
    const id = url.searchParams.get("id") || "";
    if (!FILE_DOWNLOAD_ENTITIES.includes(entity)) {
      return sendJson(res, 400, { error: "server", message: "File entity not allowed." });
    }
    try {
      const file = await downloadFile(entity, id);
      res.writeHead(200, {
        "Content-Type": file.contentType,
        "Content-Length": String(file.buffer.length),
        "Cache-Control": "private, max-age=300",
      });
      res.end(file.buffer);
    } catch (e) {
      sendError(res, e);
    }
    return;
  }

  // Settings: read current config (cookies masked).
  if (req.method === "GET" && path === "/api/config") {
    const file = readEnvFile();
    const { aspx, csrf, loader } = resolveCookieEnv();
    sendJson(res, 200, {
      baseUrl: file.CREATIO_BASE_URL || BASE_URL || "",
      allowlist: file.CREATIO_ALLOWED_ENTITIES || ALLOWED_ENTITIES.join(", "),
      maxTop: file.CREATIO_MAX_TOP || String(MAX_TOP),
      cookies: {
        aspx: mask(aspx),
        csrf: mask(csrf),
        loader: mask(loader),
        hasAspx: Boolean(aspx),
        hasCsrf: Boolean(csrf),
        hasLoader: Boolean(loader),
      },
    });
    return;
  }

  // Settings: write config to .env. Only fields present are updated; blank
  // cookie fields are treated as "leave unchanged" so a save without re-pasting
  // secrets doesn't wipe them.
  if (req.method === "POST" && path === "/api/config") {
    try {
      const body = await readBody(req);
      const updates: Record<string, string> = {};
      if (typeof body.baseUrl === "string" && body.baseUrl.trim())
        updates.CREATIO_BASE_URL = body.baseUrl.trim();
      if (typeof body.allowlist === "string")
        updates.CREATIO_ALLOWED_ENTITIES = body.allowlist.trim();
      if (typeof body.maxTop === "string" && body.maxTop.trim())
        updates.CREATIO_MAX_TOP = body.maxTop.trim();
      if (typeof body.aspx === "string" && body.aspx.trim())
        updates.CREATIO_ASPXAUTH = body.aspx.trim();
      if (typeof body.csrf === "string" && body.csrf.trim())
        updates.CREATIO_BPMCSRF = body.csrf.trim();
      if (typeof body.loader === "string" && body.loader.trim())
        updates.CREATIO_BPMLOADER = body.loader.trim();

      writeEnvFile(updates);

      // Cookies take effect immediately (client re-reads .env on next query).
      // base URL / allowlist / row cap are read once at startup — flag if changed.
      const restartNeeded =
        "CREATIO_BASE_URL" in updates ||
        "CREATIO_ALLOWED_ENTITIES" in updates ||
        "CREATIO_MAX_TOP" in updates;

      // Validate the (possibly new) cookies right away.
      const test = await testConnection();
      sendJson(res, 200, {
        saved: true,
        restartNeeded,
        connection: test,
      });
    } catch (e) {
      sendError(res, e);
    }
    return;
  }

  // Settings: pop up a real browser at the Creatio login page and lift the
  // session cookies out of it once the user finishes signing in (SSE).
  if (req.method === "POST" && path === "/api/config/login-popup") {
    await handleLoginPopup(req, res);
    return;
  }

  // AI analysis of a set of cases — streams the model output via SSE.
  if (req.method === "POST" && path === "/api/analyze") {
    await handleAnalyze(req, res);
    return;
  }

  // ---- Pipeline (Phase 1: triage) ----------------------------------------

  // Index summary, so the UI can show what the tool can see.
  if (req.method === "GET" && path === "/api/repo-index") {
    try {
      const refresh = url.searchParams.get("refresh") === "1";
      const ix = await buildIndex(refresh);
      sendJson(res, 200, {
        root: REPO_ROOT,
        builtAt: ix.builtAt,
        districts: ix.districts.size,
        files: ix.allFiles.size,
        rootFiles: ix.rootFiles.length,
        counts: ix.counts,
      });
    } catch (e) {
      sendError(res, e);
    }
    return;
  }

  // Read one indexed repo file as plain text, so a candidate can be eyeballed
  // without leaving the app. Serves ONLY paths present in the index.
  if (req.method === "GET" && path === "/api/repo-file") {
    const rel = url.searchParams.get("path") || "";
    try {
      const ix = await buildIndex();
      if (!isKnownFile(ix, rel)) {
        return sendJson(res, 404, { error: "not_found", message: "Not an indexed file." });
      }
      const abs = toAbs(rel);
      if (!abs) {
        return sendJson(res, 400, { error: "server", message: "Invalid path." });
      }
      const data = await readFile(abs, "utf8");
      res.writeHead(200, {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(data);
    } catch (e) {
      sendError(res, e);
    }
    return;
  }

  // Triage: cases -> validated candidate files (SSE).
  if (req.method === "POST" && path === "/api/triage") {
    await handleTriage(req, res);
    return;
  }

  // ---- Work on a case (Phase 2: triage -> gated worker with edit tools) ----

  // Step 1: triage one case and stage the validated brief + edit scope (SSE).
  if (req.method === "POST" && path === "/api/workon/triage") {
    await handleWorkTriage(req, res);
    return;
  }

  // Step 2: read-only planning pass — what the worker intends to change. Shown
  // on the gate so the developer approves an actual plan, not a blank cheque.
  if (req.method === "POST" && path === "/api/workon/plan") {
    await handleWorkPlan(req, res);
    return;
  }

  // Step 3: after explicit human approval in the UI, run the worker (SSE).
  if (req.method === "POST" && path === "/api/workon/run") {
    await handleWorkRun(req, res);
    return;
  }

  // Staged attachment bytes (originals + auto-cropped variants) for the UI.
  if (req.method === "GET" && path === "/api/workon/attachment") {
    await handleWorkAttachment(res, url);
    return;
  }

  // Copy a processed attachment (e.g. a cropped logo) into an in-scope
  // district folder. Developer-initiated; the agent has no route here.
  if (req.method === "POST" && path === "/api/workon/place") {
    await handleWorkPlace(req, res);
    return;
  }

  // ---- My fixes (hand-made fixes recorded against a case) -----------------
  // Zero Creatio calls in any of these: recording or browsing a fix must work
  // offline and with expired cookies.

  // List saved fix records (summaries — diff bodies omitted).
  if (req.method === "GET" && path === "/api/fixes") {
    await handleFixList(res, url);
    return;
  }

  // One full record, diffs included (expand-on-demand).
  if (req.method === "GET" && path === "/api/fixes/record") {
    await handleFixRecord(res, url);
    return;
  }

  // Scan custom-reports for uncommitted changes — the picker's source.
  if (req.method === "POST" && path === "/api/fixes/scan") {
    await handleFixScan(res);
    return;
  }

  // Save a record of the developer's own uncommitted changes.
  if (req.method === "POST" && path === "/api/fixes") {
    await handleFixSave(req, res);
    return;
  }

  // Delete a record.
  if (req.method === "POST" && path === "/api/fixes/delete") {
    await handleFixDelete(req, res);
    return;
  }

  // ---- Districts (group cases by SIS district code) -----------------------

  // District list + index stats. Reads the cache only — never triggers a build,
  // so the tab can render an honest "not built yet" state instead of hanging for
  // several minutes on first paint.
  if (req.method === "GET" && path === "/api/districts") {
    try {
      const ix = await peekDistrictIndex();
      if (!ix || !ix.cases.size) {
        return sendJson(res, 200, {
          built: false,
          since: HISTORY_SINCE,
          noDistrictLabel: NO_DISTRICT,
          districts: [],
          statuses: [],
        });
      }
      const search = url.searchParams.get("search") || "";
      const limit = clampParam(url.searchParams.get("limit"), 200, 1, 5000);
      const { districts, noDistrict, totalCodes } = listDistricts(ix, { search, limit });
      sendJson(res, 200, {
        built: true,
        since: HISTORY_SINCE,
        noDistrictLabel: NO_DISTRICT,
        stats: indexStats(ix),
        statuses: statusesPresent(ix),
        districts,
        noDistrict,
        totalCodes,
        shown: districts.length,
      });
    } catch (e) {
      sendError(res, e);
    }
    return;
  }

  // Build or advance the index (SSE). Default is incremental; ?refresh=1 forces
  // a full rebuild from scratch.
  if (req.method === "POST" && path === "/api/districts/build") {
    await handleDistrictBuild(req, res, url);
    return;
  }

  // One district's ticket history. `code` is a query param rather than a path
  // segment because the no-district bucket's label contains spaces.
  if (req.method === "GET" && path === "/api/districts/history") {
    try {
      const ix = await peekDistrictIndex();
      if (!ix || !ix.cases.size) {
        return sendJson(res, 409, { error: "not_built", message: "District index not built yet." });
      }
      const code = url.searchParams.get("code") || "";
      if (!code) {
        return sendJson(res, 400, { error: "server", message: "Missing district code." });
      }
      const opts = historyOptions(url);
      const { rows, total, truncated } = districtHistory(ix, code, opts);
      sendJson(res, 200, { code, rows, total, truncated, tally: statusTally(rows) });
    } catch (e) {
      sendError(res, e);
    }
    return;
  }

  // Cross-district text search.
  if (req.method === "GET" && path === "/api/districts/search") {
    try {
      const ix = await peekDistrictIndex();
      if (!ix || !ix.cases.size) {
        return sendJson(res, 409, { error: "not_built", message: "District index not built yet." });
      }
      const opts = historyOptions(url);
      if (!opts.q) return sendJson(res, 200, { rows: [], total: 0, truncated: false, tally: {} });
      const { rows, total, truncated } = searchCases(ix, opts);
      sendJson(res, 200, { rows, total, truncated, tally: statusTally(rows) });
    } catch (e) {
      sendError(res, e);
    }
    return;
  }

  // On-demand description scan for unattributed cases (SSE).
  if (req.method === "POST" && path === "/api/districts/resolve-text") {
    await handleResolveText(req, res);
    return;
  }

  // Full description + timeline for every ticket in a district's (filtered)
  // history, in one pass — feeds the "view full details" page (SSE).
  if (req.method === "POST" && path === "/api/districts/full-detail") {
    await handleDistrictFullDetail(req, res);
    return;
  }

  sendJson(res, 404, { error: "not_found", message: `No API route ${req.method} ${path}` });
}

// ---------------------------------------------------------------------------
// Analyze handler (Server-Sent Events)
// ---------------------------------------------------------------------------
function sse(res: ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

async function handleCases(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: any;
  try {
    body = await readBody(req);
  } catch (e) {
    return sendError(res, e);
  }

  const mode = body.mode as SelectMode;
  const statuses: string[] = Array.isArray(body.statuses) ? body.statuses : OPEN_ACTIVE;
  const detail: DetailKind[] = Array.isArray(body.detail) ? body.detail : ["summary"];

  // Phase 1: find the cases. Errors here happen BEFORE the stream opens, so we
  // can return a normal JSON error (drives the cookie-expired banner).
  let found: FindResult;
  try {
    found = await findCases({ mode, guids: body.guids, numbers: body.numbers, statuses, before: body.before });
  } catch (e) {
    return sendError(res, e);
  }

  const tally: Record<string, number> = {};
  for (const c of found.cases) tally[c.Status] = (tally[c.Status] || 0) + 1;
  const needDetail = detail.some((d) => d !== "summary");

  // Open the SSE stream and hand the table over immediately.
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  sse(res, "found", {
    cases: found.cases,
    tally,
    truncated: found.truncated,
    caveats: found.caveats,
    needDetail,
    total: found.cases.length,
  });

  if (!needDetail) {
    sse(res, "done", {});
    res.end();
    return;
  }

  // Phase 2: fetch per-case detail with limited concurrency, reporting progress.
  const total = found.cases.length;
  let done = 0;
  let idx = 0;
  const aborted = { v: false };
  req.on("close", () => (aborted.v = true));

  async function worker(): Promise<void> {
    while (idx < total && !aborted.v) {
      const i = idx++;
      try {
        const d = await getCaseDetail(found.cases[i], detail);
        sse(res, "case", { index: i, detail: d });
      } catch (e) {
        if (e instanceof AuthError) {
          sse(res, "error", { kind: "auth", message: e.message });
          aborted.v = true;
          return;
        }
        sse(res, "case", { index: i, detail: {}, error: e instanceof Error ? e.message : String(e) });
      }
      done++;
      sse(res, "progress", { done, total });
    }
  }

  const CONCURRENCY = 4;
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, total) }, () => worker()));
  if (!aborted.v) sse(res, "done", {});
  res.end();
}

async function handleLoginPopup(req: IncomingMessage, res: ServerResponse): Promise<void> {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  try {
    const { aspx, csrf, loader } = await loginViaBrowser((message) => sse(res, "progress", { message }));

    const updates: Record<string, string> = { CREATIO_ASPXAUTH: aspx, CREATIO_BPMCSRF: csrf };
    if (loader) updates.CREATIO_BPMLOADER = loader;
    writeEnvFile(updates);
    seedCookiesFromEnv();

    const connection = await testConnection();
    sse(res, "done", { connection });
  } catch (e) {
    sse(res, "error", {
      kind: e instanceof LoginCancelledError ? "cancelled" : "server",
      message: e instanceof Error ? e.message : String(e),
    });
  }
  res.end();
}

async function handleAnalyze(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: any;
  try {
    body = await readBody(req);
  } catch (e) {
    return sendError(res, e);
  }

  const preset = (body.preset as Preset) || "summarize";
  const question = typeof body.question === "string" ? body.question : "";
  const rows: CaseRow[] = Array.isArray(body.cases) ? body.cases : [];
  if (!rows.length) {
    return sendJson(res, 400, { error: "server", message: "No cases selected to analyze." });
  }
  if (preset === "ask" && !question.trim()) {
    return sendJson(res, 400, { error: "server", message: "Type a question to ask." });
  }

  // Auto-detail: make sure every case has description + timeline for full context.
  let cases: AnalyzableCase[];
  try {
    cases = await Promise.all(
      rows.map(async (c) => ({
        ...c,
        detail: await getCaseDetail(c, ["description", "timeline"] as DetailKind[]),
      }))
    );
  } catch (e) {
    return sendError(res, e);
  }

  // Open the SSE stream.
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  sse(res, "start", { count: cases.length });

  const controller = new AbortController();
  req.on("close", () => controller.abort());

  const runner = analyzeCases(
    { preset, question, cases, signal: controller.signal, model: process.env.CREATIO_APP_MODEL || undefined },
    {
      onChunk: (text) => sse(res, "chunk", { text }),
      onDone: (meta) => {
        sse(res, "done", meta);
        res.end();
      },
      onError: (err) => {
        sse(res, "error", { kind: err.kind, message: err.message });
        res.end();
      },
    }
  );

  req.on("close", () => runner.kill());
}

// ---------------------------------------------------------------------------
// Triage handler (Server-Sent Events)
//
// Ordering matters here: every Creatio read happens BEFORE any agent spawns.
// Cookies expire in hours, and the agent runs are the slow part — front-loading
// the network work means an expiry fails fast with nothing half-done.
// ---------------------------------------------------------------------------
const TRIAGE_MAX_CASES = 10; // ten sequential agent runs is already 10-20 min

async function handleTriage(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: any;
  try {
    body = await readBody(req);
  } catch (e) {
    return sendError(res, e);
  }

  if (!claudeAvailable()) {
    return sendJson(res, 400, {
      error: "server",
      message:
        "The Claude CLI is not installed. Run `npm i -g @anthropic-ai/claude-code`, then `claude` once to log in.",
    });
  }

  const mode = (body.mode as SelectMode) || "recent";
  const statuses: string[] = Array.isArray(body.statuses) ? body.statuses : ["In progress"];
  const limit = Math.max(1, Math.min(Number(body.maxCases) || TRIAGE_MAX_CASES, 25));

  // Pre-flight: refuse to start on stale cookies rather than dying at case 7.
  const conn = await testConnection();
  if (!conn.ok) {
    return sendJson(res, 401, {
      error: "auth",
      message: `Creatio is not reachable: ${conn.error || "unknown error"}`,
    });
  }

  // 1. Find the cases.
  let found: FindResult;
  try {
    found = await findCases({
      mode,
      guids: body.guids,
      numbers: body.numbers,
      statuses,
      before: body.before,
    });
  } catch (e) {
    return sendError(res, e);
  }

  const cases = found.cases.slice(0, limit);
  if (!cases.length) {
    return sendJson(res, 200, { error: "", message: "No matching cases.", cases: [] });
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  sse(res, "found", {
    cases,
    total: cases.length,
    truncated: found.cases.length > cases.length,
    caveats: found.caveats,
  });

  const aborted = { v: false };
  let current: { kill: () => void } | null = null;
  req.on("close", () => {
    aborted.v = true;
    current?.kill();
  });

  // 2. Fetch detail up front, bounded concurrency (matches handleCases).
  const detailed: AnalyzableCase[] = cases.map((c) => ({ ...c }));
  let idx = 0;
  async function detailWorker(): Promise<void> {
    while (idx < detailed.length && !aborted.v) {
      const i = idx++;
      try {
        detailed[i].detail = await getCaseDetail(cases[i], [
          "description",
          "timeline",
        ] as DetailKind[]);
      } catch (e) {
        if (e instanceof AuthError) {
          sse(res, "error", { kind: "auth", message: e.message });
          aborted.v = true;
          return;
        }
        detailed[i].detail = {};
      }
      sse(res, "progress", { phase: "detail", done: i + 1, total: detailed.length });
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(4, detailed.length) }, () => detailWorker())
  );
  if (aborted.v) return void res.end();

  // 3. Build the index (may take a second on a cold cache).
  let ix: RepoIndex;
  try {
    sse(res, "progress", { phase: "index", message: "Indexing custom-reports…" });
    ix = await buildIndex(false, (m) => sse(res, "progress", { phase: "index", message: m }));
    sse(res, "indexed", {
      districts: ix.districts.size,
      files: ix.allFiles.size,
      builtAt: ix.builtAt,
    });
  } catch (e) {
    sse(res, "error", { kind: "index", message: e instanceof Error ? e.message : String(e) });
    return void res.end();
  }

  // 4. Triage each case serially. Parallel CLI spawns rate-limit and make the
  //    audit log interleave; reviewability beats throughput here.
  for (let i = 0; i < detailed.length && !aborted.v; i++) {
    const c = detailed[i];
    const { guesses, mentions, unresolvedMentions } = analyzeCaseSignals(ix, {
      accountName: c.Account,
      subject: c.Subject,
      descriptionText: caseProse(c),
    });
    sse(res, "progress", {
      phase: "triage",
      done: i,
      total: detailed.length,
      caseNumber: c.Number,
    });

    const brief = await new Promise<CaseBrief | null>((resolve) => {
      current = triageCase(
        {
          case: c,
          index: ix,
          guesses,
          mentions,
          unresolvedMentions,
          model: process.env.CREATIO_APP_MODEL || undefined,
        },
        {
          onDone: (b) => resolve(b),
          onError: (err) => {
            sse(res, "caseError", {
              index: i,
              caseNumber: c.Number,
              kind: err.kind,
              message: err.message,
            });
            resolve(null);
          },
        }
      );
    });
    current = null;

    if (brief) {
      sse(res, "brief", {
        index: i,
        caseNumber: c.Number,
        brief,
        guesses: guesses.slice(0, 5).map((g) => ({
          code: g.code,
          score: g.score,
          why: g.why,
          subrepos: [...new Set(g.entries.map((e) => e.subrepo))],
        })),
        mentions,
      });
    }
    sse(res, "progress", { phase: "triage", done: i + 1, total: detailed.length });
  }

  if (!aborted.v) sse(res, "done", { total: detailed.length });
  res.end();
}

// ---------------------------------------------------------------------------
// Work-on-a-case handlers (Server-Sent Events)
//
// Two-step by design. Step 1 (triage) reads the raw case text in the isolated,
// tool-less agent and stages the validated brief server-side under a one-time
// workId. Step 2 (run) only fires after the user clicks approve in the UI, and
// spawns the edit-capable worker from the STAGED brief — the client never gets
// to supply the brief or the scope, only the ticket back.
// ---------------------------------------------------------------------------
/**
 * Everything a case says in prose — description plus every timeline entry.
 * Cases often name the template in a follow-up post rather than the original
 * description, so both feed the deterministic file/district scan.
 */
function caseProse(c: AnalyzableCase): string {
  const d = c.detail || {};
  const tl = d.timeline || (d.latest ? [d.latest] : []);
  return [d.description || "", ...tl.map((e) => e.text || "")].filter(Boolean).join("\n");
}

interface StagedWork {
  caseNumber: string;
  brief: CaseBrief;
  scope: WorkScope;
  attachments?: StagedAttachments;
  /** Developer guidance used at triage; the default for the run. */
  hint: string;
  /** The most recent plan from /api/workon/plan, once the developer has one. */
  plan?: WorkPlan;
  /**
   * Git state before the FIRST agent run on this ticket, kept so a plan worked
   * one file at a time reports one accumulating diff. Re-baselining per run
   * would file the previous run's edits under "already modified before this
   * run" — i.e. blame the agent's own work on the developer.
   */
  baseline?: GitBaseline;
  createdAt: number;
  running: boolean;
}

/**
 * Developer guidance is client-supplied but TRUSTED by design: it is typed by
 * the single local user in their own UI, not drawn from case text. It steers
 * what the agent does; it can never widen what the agent may touch, because
 * paths still come from the validated brief and the edit scope from the staged
 * WorkScope. Capped only so a paste cannot bloat the prompt.
 */
function readHint(body: any): string {
  return typeof body?.hint === "string" ? body.hint.trim().slice(0, MAX_HINT) : "";
}

const workStore = new Map<string, StagedWork>();
const WORK_TTL_MS = 30 * 60 * 1000;
let workRunActive = false; // one edit-capable agent at a time, ever

/**
 * Attachments outlive the one-shot work ticket: the developer places a logo
 * AFTER reading the run's report, by which time workStore has dropped the
 * workId. Keyed by case number; carries the scope dirs placement may target.
 */
interface AttachSession {
  attachments: StagedAttachments;
  scopeDirs: string[];
  createdAt: number;
}
const attachStore = new Map<string, AttachSession>();

function gcWorkStore(): void {
  const now = Date.now();
  for (const [k, v] of workStore) {
    if (!v.running && now - v.createdAt > WORK_TTL_MS) workStore.delete(k);
  }
  for (const [k, v] of attachStore) {
    if (now - v.createdAt > WORK_TTL_MS) attachStore.delete(k);
  }
}

async function handleWorkTriage(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: any;
  try {
    body = await readBody(req);
  } catch (e) {
    return sendError(res, e);
  }

  const number = typeof body.number === "string" ? body.number.trim() : "";
  if (!/^[A-Za-z0-9-]{3,30}$/.test(number)) {
    return sendJson(res, 400, { error: "server", message: "Invalid case number." });
  }
  if (!claudeAvailable()) {
    return sendJson(res, 400, {
      error: "server",
      message:
        "The Claude CLI is not installed. Run `npm i -g @anthropic-ai/claude-code`, then `claude` once to log in.",
    });
  }
  if (!(await repoAvailable())) {
    return sendJson(res, 400, {
      error: "server",
      message: `The custom-reports tree was not found at ${REPO_ROOT}.`,
    });
  }

  // Pre-flight: fail fast on stale cookies, before any agent time is spent.
  const conn = await testConnection();
  if (!conn.ok) {
    return sendJson(res, 401, {
      error: "auth",
      message: `Creatio is not reachable: ${conn.error || "unknown error"}`,
    });
  }

  let found: FindResult;
  try {
    found = await findCases({ mode: "number", numbers: [number] });
  } catch (e) {
    return sendError(res, e);
  }
  const c = found.cases[0];
  if (!c) {
    return sendJson(res, 404, { error: "not_found", message: `No case ${number} found.` });
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  const aborted = { v: false };
  let current: { kill: () => void } | null = null;
  req.on("close", () => {
    aborted.v = true;
    current?.kill();
  });

  sse(res, "progress", { phase: "detail", message: `Reading ${c.Number}…` });
  const detailed: AnalyzableCase = { ...c };
  try {
    detailed.detail = await getCaseDetail(c, ["description", "timeline"] as DetailKind[]);
  } catch (e) {
    sse(res, "error", {
      kind: e instanceof AuthError ? "auth" : "server",
      message: e instanceof Error ? e.message : String(e),
    });
    return void res.end();
  }
  if (aborted.v) return void res.end();

  let ix: RepoIndex;
  try {
    sse(res, "progress", { phase: "index", message: "Indexing custom-reports…" });
    ix = await buildIndex(false, (m) => sse(res, "progress", { phase: "index", message: m }));
  } catch (e) {
    sse(res, "error", { kind: "index", message: e instanceof Error ? e.message : String(e) });
    return void res.end();
  }

  const { guesses, mentions, unresolvedMentions } = analyzeCaseSignals(ix, {
    accountName: c.Account,
    subject: c.Subject,
    descriptionText: caseProse(detailed),
  });

  // Attachments: best-effort — a case without them (or a broken download)
  // must never block the triage → fix pipeline.
  let attachments: StagedAttachments | undefined;
  try {
    sse(res, "progress", { phase: "attachments", message: "Fetching case attachments…" });
    attachments = await stageAttachments(detailed);
    audit({
      t: "attachments",
      caseNumber: c.Number,
      count: attachments.files.length,
      images: attachments.files.filter((f) => f.isImage).length,
      notes: attachments.notes,
    });
  } catch (e) {
    attachments = undefined;
    sse(res, "progress", {
      phase: "attachments",
      message: `Attachments unavailable: ${e instanceof Error ? e.message : String(e)}`,
    });
  }
  if (aborted.v) return void res.end();

  const hint = readHint(body);
  sse(res, "progress", { phase: "triage", message: `Triaging ${c.Number}…` });
  const brief = await new Promise<CaseBrief | null>((resolve) => {
    current = triageCase(
      {
        case: detailed,
        index: ix,
        guesses,
        mentions,
        unresolvedMentions,
        hint,
        model: process.env.CREATIO_APP_MODEL || undefined,
      },
      {
        onDone: (b) => resolve(b),
        onError: (err) => {
          sse(res, "error", { kind: err.kind, message: err.message });
          resolve(null);
        },
      }
    );
  });
  current = null;
  if (!brief || aborted.v) return void res.end();

  const scope = await buildWorkScope(brief, ix);
  const canProceed = brief.candidateFiles.length > 0 && scope.dirs.length > 0;

  gcWorkStore();
  const workId = randomUUID();
  workStore.set(workId, {
    caseNumber: c.Number,
    brief,
    scope,
    attachments,
    hint,
    createdAt: Date.now(),
    running: false,
  });
  if (attachments?.files.length) {
    attachStore.set(c.Number, {
      attachments,
      scopeDirs: [...scope.dirs],
      createdAt: Date.now(),
    });
  }

  sse(res, "brief", {
    workId,
    caseNumber: c.Number,
    subject: c.Subject,
    brief,
    hint, // echo what triage was told, so the UI can keep the box in sync
    guesses: guesses.slice(0, 5).map((g) => ({
      code: g.code,
      score: g.score,
      why: g.why,
      subrepos: [...new Set(g.entries.map((e) => e.subrepo))],
    })),
    scope,
    canProceed,
    // Filenames only — the UI fetches bytes through /api/workon/attachment.
    attachments: (attachments?.files || []).map((f) => ({
      name: f.name,
      isImage: f.isImage,
      contentType: f.contentType,
      bytes: f.bytes,
      width: f.width,
      height: f.height,
      croppedPng: f.croppedPng,
      croppedJpg: f.croppedJpg,
      cropped: f.cropped,
      probableLogo: f.probableLogo,
      error: f.error,
    })),
    attachmentNotes: attachments?.notes || [],
  });
  sse(res, "done", {});
  res.end();
}

/**
 * Read-only planning pass over an already-staged brief. Produces the "what
 * Claude is planning" section on the gate. Re-runnable: the developer types a
 * correction and plans again, as many times as it takes, because nothing here
 * can touch a file — planWorkOn() holds no edit tools.
 *
 * Deliberately NOT gated on workRunActive: planning is read-only, so it does
 * not compete with the one-edit-run-at-a-time rule.
 */
async function handleWorkPlan(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: any;
  try {
    body = await readBody(req);
  } catch (e) {
    return sendError(res, e);
  }

  const staged = typeof body.workId === "string" ? workStore.get(body.workId) : undefined;
  if (!staged) {
    return sendJson(res, 404, {
      error: "not_found",
      message: "This work ticket expired or was never staged. Re-run triage.",
    });
  }
  if (!staged.brief.candidateFiles.length || !staged.scope.dirs.length) {
    return sendJson(res, 400, {
      error: "server",
      message: "This brief has no verified candidate files / edit scope — nothing to plan.",
    });
  }

  // A correction typed after triage steers the plan without re-triaging.
  const hint = readHint(body) || staged.hint;
  const runId = newRunId();
  if (hint) {
    audit({ t: "hint", runId, caseNumber: staged.caseNumber, stage: "plan", text: hint });
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  sse(res, "progress", { phase: "plan", message: "Reading the candidate files…" });

  const controller = new AbortController();
  req.on("close", () => controller.abort());

  await new Promise<void>((resolve) => {
    planWorkOn(
      {
        runId,
        caseNumber: staged.caseNumber,
        brief: staged.brief,
        scope: staged.scope,
        attachments: staged.attachments,
        hint,
        model: process.env.CREATIO_APP_MODEL || undefined,
        signal: controller.signal,
      },
      {
        onTool: (name, target) => sse(res, "tool", { name, target }),
        onDone: (plan, meta) => {
          staged.plan = plan; // what the run will be handed if approved
          sse(res, "plan", { workId: body.workId, plan, hint, meta });
          sse(res, "done", {});
          resolve();
        },
        onError: (err) => {
          // A failed plan must not block the case: the gate keeps its approve
          // button and the run simply goes ahead without one.
          sse(res, "error", { kind: err.kind, message: err.message });
          resolve();
        },
      }
    );
  });
  res.end();
}

/**
 * "Do only this file" — resolve body.onlyPath against the staged plan.
 *
 * The client picks WHICH step runs; it never supplies the path itself. The path
 * must equal the target of a real edit/create step that validatePlan() already
 * checked, and it is re-verified against the staged scope here rather than
 * trusting the step's own outOfScope flag — the client sends only a selector,
 * and both ends of the narrowing are checked server-side.
 *
 * Returns {} for a normal whole-plan run.
 */
function resolveOnlyStep(body: any, staged: StagedWork): { step?: PlanStep; error?: string } {
  const want = typeof body?.onlyPath === "string" ? body.onlyPath.trim() : "";
  if (!want) return {};

  if (!staged.plan) {
    return { error: "There is no plan to pick a file from. Re-plan, then choose a file." };
  }
  const inScope = staged.scope.dirs.some((d) => want === d || want.startsWith(d + "/"));
  const step = staged.plan.steps.find(
    (s) => s.path === want && s.action !== "read-only" && !s.outOfScope
  );
  if (!step || !inScope) {
    return {
      error: `${want} is not an editable step of the current plan. Re-plan, then choose a file from it.`,
    };
  }
  if (want.includes(",")) {
    // Cannot be expressed as a single --allowed-tools rule, so it cannot be
    // permitted safely for a one-file run.
    return { error: `${want} contains a comma; run the whole plan instead.` };
  }
  return { step };
}

async function handleWorkRun(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: any;
  try {
    body = await readBody(req);
  } catch (e) {
    return sendError(res, e);
  }

  const staged = typeof body.workId === "string" ? workStore.get(body.workId) : undefined;
  if (!staged) {
    return sendJson(res, 404, {
      error: "not_found",
      message: "This work ticket expired or was never staged. Re-run triage.",
    });
  }
  if (staged.running || workRunActive) {
    return sendJson(res, 409, {
      error: "busy",
      message: "Another work run is already in progress. One at a time keeps the audit readable.",
    });
  }
  if (!staged.brief.candidateFiles.length || !staged.scope.dirs.length) {
    return sendJson(res, 400, {
      error: "server",
      message: "This brief has no verified candidate files / edit scope — handle the case by hand.",
    });
  }

  const { step: onlyStep, error: onlyError } = resolveOnlyStep(body, staged);
  if (onlyError) {
    return sendJson(res, 400, { error: "server", message: onlyError });
  }

  staged.running = true;
  workRunActive = true;
  const runId = newRunId();
  // The click on "let Claude edit" IS the human approval — record it, and record
  // which file when the developer approved just one step.
  audit({
    t: "human",
    runId,
    action: "approve",
    stage: "fix",
    ...(onlyStep ? { only: onlyStep.path } : {}),
  });

  // The developer may have refined their instructions after reading the brief;
  // fall back to whatever triage was given.
  const hint = readHint(body) || staged.hint;
  if (hint) {
    audit({ t: "hint", runId, caseNumber: staged.caseNumber, stage: "fix", text: hint });
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  sse(res, "start", {
    caseNumber: staged.caseNumber,
    scope: staged.scope,
    runId,
    planned: Boolean(staged.plan),
    onlyPath: onlyStep?.path,
  });

  const subrepos = [...new Set(staged.scope.dirs.map((d) => d.split("/")[0]))];
  staged.baseline ??= await gitBaseline(subrepos);
  const baseline = staged.baseline;

  const controller = new AbortController();
  const finish = (): void => {
    staged.running = false;
    workRunActive = false;
    // One shot per triage for a whole-plan run. A single-file run KEEPS the
    // ticket: working a plan file by file is the point, and consuming the ticket
    // on the first file would force a re-triage for the second.
    if (!onlyStep) workStore.delete(body.workId);
    res.end();
  };

  const runner = workOnCase(
    {
      runId,
      caseNumber: staged.caseNumber,
      brief: staged.brief,
      scope: staged.scope,
      attachments: staged.attachments,
      hint,
      // What the developer read on the gate before approving — cut to the one
      // step they clicked, if they clicked one.
      plan: onlyStep && staged.plan ? narrowPlanToStep(staged.plan, onlyStep) : staged.plan,
      onlyPaths: onlyStep ? [onlyStep.path] : undefined,
      model: process.env.CREATIO_APP_MODEL || undefined,
      signal: controller.signal,
    },
    {
      onChunk: (text) => sse(res, "chunk", { text }),
      onTool: (name, target) => sse(res, "tool", { name, target }),
      onDone: (meta) => {
        void (async () => {
          try {
            const { changes, preexistingDirty } = await collectChanges(baseline);
            audit({
              t: "patch",
              runId,
              files: changes.map((ch) => ch.path),
              bytes: changes.reduce((n, ch) => n + ch.diff.length, 0),
            });
            sse(res, "changes", { changes, preexistingDirty });
          } catch (e) {
            sse(res, "changes", {
              changes: [],
              preexistingDirty: [],
              error: e instanceof Error ? e.message : String(e),
            });
          }
          sse(res, "done", meta);
          finish();
        })();
      },
      onError: (err) => {
        sse(res, "error", { kind: err.kind, message: err.message });
        finish();
      },
    }
  );

  req.on("close", () => {
    controller.abort();
    runner.kill();
  });
}

// ---------------------------------------------------------------------------
// Attachment handlers — serve staged bytes to the UI; place a file on approval
// ---------------------------------------------------------------------------
const ATTACH_CT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
};

/** Resolve a (case, name) pair against the staged session, refusing anything
 *  that is not exactly a staged filename — no path input touches the fs. */
function stagedAttachment(
  caseNumber: string,
  name: string
): { session: AttachSession; abs: string } | null {
  const session = attachStore.get(caseNumber);
  if (!session) return null;
  const known = session.attachments.files.some(
    (f) =>
      !f.error &&
      (f.name === name || f.croppedPng === name || f.croppedJpg === name)
  );
  if (!known) return null;
  return { session, abs: join(session.attachments.dir, name) };
}

async function handleWorkAttachment(res: ServerResponse, url: URL): Promise<void> {
  const caseNumber = url.searchParams.get("case") || "";
  const name = url.searchParams.get("name") || "";
  const hit = stagedAttachment(caseNumber, name);
  if (!hit) {
    return sendJson(res, 404, {
      error: "not_found",
      message: "No such staged attachment (the staging session may have expired — re-run triage).",
    });
  }
  try {
    const buf = await readFile(hit.abs);
    res.writeHead(200, {
      "Content-Type": ATTACH_CT[extname(name).toLowerCase()] || "application/octet-stream",
      "Content-Length": String(buf.length),
      "Cache-Control": "private, max-age=300",
    });
    res.end(buf);
  } catch (e) {
    sendError(res, e);
  }
}

const SAFE_PLACE_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,79}\.(png|jpe?g|gif)$/i;

async function handleWorkPlace(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: any;
  try {
    body = await readBody(req);
  } catch (e) {
    return sendError(res, e);
  }

  const caseNumber = typeof body.case === "string" ? body.case.trim() : "";
  const file = typeof body.file === "string" ? body.file : "";
  const dir = typeof body.dir === "string" ? body.dir : "";
  const saveAs = typeof body.saveAs === "string" ? body.saveAs.trim() : "";

  const hit = stagedAttachment(caseNumber, file);
  if (!hit) {
    return sendJson(res, 404, {
      error: "not_found",
      message: "No such staged attachment (the staging session may have expired — re-run triage).",
    });
  }
  // Destination folder must be one the human already approved as edit scope.
  if (!hit.session.scopeDirs.includes(dir)) {
    return sendJson(res, 400, {
      error: "server",
      message: "Destination folder is outside this case's approved edit scope.",
    });
  }
  if (!SAFE_PLACE_NAME.test(saveAs)) {
    return sendJson(res, 400, {
      error: "server",
      message: "Target filename must be a plain image name (png/jpg/gif), no paths.",
    });
  }
  const destAbs = toAbs(`${dir}/${saveAs}`);
  if (!destAbs) {
    return sendJson(res, 400, { error: "server", message: "Invalid destination path." });
  }

  try {
    const bytes = await readFile(hit.abs);
    let replaced = false;
    try {
      await readFile(destAbs);
      replaced = true; // exists — an uncommitted overwrite git can always undo
    } catch {
      /* new file */
    }
    await writeFileAtomic(destAbs, bytes);
    const rel = `${dir}/${saveAs}`;
    audit({ t: "place", caseNumber, from: file, to: rel, bytes: bytes.length, replaced });
    sendJson(res, 200, { placed: rel, bytes: bytes.length, replaced });
  } catch (e) {
    sendError(res, e);
  }
}

/** Plain write is fine for these small images, but never leave a torn file. */
async function writeFileAtomic(abs: string, data: Buffer): Promise<void> {
  const tmp = `${abs}.tmp-${process.pid}`;
  await writeFile(tmp, data);
  await rename(tmp, abs);
}

// ---------------------------------------------------------------------------
// My-fixes handlers — record the developer's hand-made fixes (uncommitted git
// changes in custom-reports) against a case number, durably in .state/.
// ---------------------------------------------------------------------------
const FIX_NOTE_MAX = 4000;
const FIX_PATHS_MAX = 300;
const CASE_NUMBER_RE = /^[A-Za-z0-9-]{3,30}$/;

/** List/summary view of a record: file metadata without the diff bodies. */
function fixSummary(f: FixRecord) {
  return {
    ...f,
    files: f.files.map(({ diff, ...rest }) => ({ ...rest, bytes: diff.length })),
  };
}

async function handleFixList(res: ServerResponse, url: URL): Promise<void> {
  try {
    const caseFilter = (url.searchParams.get("case") || "").trim().toLowerCase();
    let fixes = await loadFixes();
    if (caseFilter) fixes = fixes.filter((f) => f.caseNumber.toLowerCase() === caseFilter);
    sendJson(res, 200, { fixes: fixes.map(fixSummary) });
  } catch (e) {
    sendError(res, e);
  }
}

async function handleFixRecord(res: ServerResponse, url: URL): Promise<void> {
  try {
    const id = url.searchParams.get("id") || "";
    const fix = (await loadFixes()).find((f) => f.id === id);
    if (!fix) {
      return sendJson(res, 404, { error: "not_found", message: "No such fix record." });
    }
    sendJson(res, 200, { fix });
  } catch (e) {
    sendError(res, e);
  }
}

async function handleFixScan(res: ServerResponse): Promise<void> {
  try {
    if (!(await repoAvailable())) {
      return sendJson(res, 400, {
        error: "server",
        message: `The custom-reports tree was not found at ${REPO_ROOT}.`,
      });
    }
    const changes = await scanWorkingChanges();
    sendJson(res, 200, { changes, repoRoot: REPO_ROOT });
  } catch (e) {
    sendError(res, e);
  }
}

async function handleFixSave(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const body = await readBody(req);

    const caseNumber = typeof body.caseNumber === "string" ? body.caseNumber.trim() : "";
    if (!CASE_NUMBER_RE.test(caseNumber)) {
      return sendJson(res, 400, { error: "server", message: "Invalid case number." });
    }
    const note = typeof body.note === "string" ? body.note.trim().slice(0, FIX_NOTE_MAX) : "";
    if (!note) {
      return sendJson(res, 400, { error: "server", message: "Add a short note about the fix." });
    }
    const subject = typeof body.subject === "string" ? body.subject.trim().slice(0, 300) : "";
    const paths: string[] = Array.isArray(body.paths)
      ? body.paths.filter((p: unknown): p is string => typeof p === "string").slice(0, FIX_PATHS_MAX)
      : [];
    if (!paths.length) {
      return sendJson(res, 400, { error: "server", message: "Select at least one changed file." });
    }

    // Re-scan and keep only the selected paths. The client never supplies diff
    // content, and a path that doesn't match the scan never touches the fs.
    const wanted = new Set(paths.map((p) => p.toLowerCase()));
    const scan = await scanWorkingChanges();
    const kept = scan.filter((c) => wanted.has(c.path.toLowerCase()));
    if (kept.length < wanted.size) {
      const found = new Set(kept.map((c) => c.path.toLowerCase()));
      const missing = paths.filter((p) => !found.has(p.toLowerCase()));
      return sendJson(res, 409, {
        error: "stale_scan",
        message:
          "The working tree changed since the scan — some selected files are no longer modified. Re-scan and try again.",
        missing,
      });
    }

    // District codes for later browsing — best-effort, never blocks the save.
    let districts: string[] = [];
    try {
      const ix = await buildIndex();
      districts = [
        ...new Set(
          kept
            .map((c) => districtForPath(ix, c.path)?.code)
            .filter((x): x is string => Boolean(x))
        ),
      ];
    } catch {
      districts = [];
    }

    const fix = await saveFix({
      caseNumber,
      subject: subject || undefined,
      note,
      districts,
      files: kept,
    });
    audit({
      t: "fix.save",
      id: fix.id,
      caseNumber,
      files: kept.map((c) => c.path),
      bytes: kept.reduce((n, c) => n + c.diff.length, 0),
    });
    sendJson(res, 200, { fix: fixSummary(fix) });
  } catch (e) {
    sendError(res, e);
  }
}

async function handleFixDelete(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const body = await readBody(req);
    const id = typeof body.id === "string" ? body.id : "";
    const removed = await deleteFix(id);
    if (!removed) {
      return sendJson(res, 404, { error: "not_found", message: "No such fix record." });
    }
    audit({ t: "fix.delete", id, caseNumber: removed.caseNumber });
    sendJson(res, 200, { deleted: true });
  } catch (e) {
    sendError(res, e);
  }
}

// ---------------------------------------------------------------------------
// District index handlers (Server-Sent Events)
// ---------------------------------------------------------------------------

/**
 * Build or advance the district index, streaming progress.
 *
 * The first full 2-year build is several minutes of paging, so this streams and
 * the index self-persists every 20 pages: closing the tab or an expired cookie
 * costs the remaining pages, not the completed ones, and the next run resumes
 * from the stored backfill cursor.
 */
async function handleDistrictBuild(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL
): Promise<void> {
  const force = url.searchParams.get("refresh") === "1";
  // Optional cap so the UI can offer "index a bit more" without committing to
  // the whole backfill in one go.
  const maxPagesRaw = url.searchParams.get("maxPages");
  const maxPages = maxPagesRaw ? clampParam(maxPagesRaw, 50, 1, 5000) : undefined;

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  const aborted = { v: false };
  req.on("close", () => (aborted.v = true));

  sse(res, "start", { force, since: HISTORY_SINCE, maxPages: maxPages ?? null });

  try {
    const ix = await buildDistrictIndex({ force, maxPages }, (p) => {
      if (aborted.v) return;
      sse(res, "progress", p);
    });
    if (!aborted.v) {
      sse(res, "done", {
        stats: indexStats(ix),
        statuses: statusesPresent(ix),
        totalCodes: ix.registry.size,
      });
    }
  } catch (e) {
    if (!aborted.v) {
      // Whatever was fetched is already on disk — say so, so the user knows a
      // retry resumes rather than restarts.
      const partial = await peekDistrictIndex();
      sse(res, "error", {
        kind: e instanceof AuthError ? "auth" : "server",
        message: e instanceof Error ? e.message : String(e),
        partial: partial ? indexStats(partial) : null,
      });
    }
  }
  res.end();
}

/**
 * Scan `Symptoms` for a district code on cases the bulk pass could not attribute.
 *
 * Kept out of the build for a reason: 180k+ HTML descriptions is not a fetch
 * worth making, and most unattributed cases are higher-ed accounts that
 * genuinely have no district. Running it over what is on screen keeps the cost
 * proportional to the attention paid.
 */
async function handleResolveText(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: any;
  try {
    body = await readBody(req);
  } catch (e) {
    return sendError(res, e);
  }

  const ids: string[] = Array.isArray(body.ids)
    ? body.ids.filter((x: unknown) => typeof x === "string" && /^[0-9a-fA-F-]{36}$/.test(x))
    : [];
  if (!ids.length) {
    return sendJson(res, 400, { error: "server", message: "No case ids supplied." });
  }

  const ix = await peekDistrictIndex();
  if (!ix || !ix.cases.size) {
    return sendJson(res, 409, { error: "not_built", message: "District index not built yet." });
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  const aborted = { v: false };
  req.on("close", () => (aborted.v = true));

  // Cap the batch so one click can't turn into a very long scan.
  const capped = ids.slice(0, 200);
  sse(res, "start", { total: capped.length });

  try {
    const { promoted, scanned } = await resolveFromDescriptions(ix, capped, (done, total, found) => {
      if (!aborted.v) sse(res, "progress", { done, total, promoted: found });
    });
    if (!aborted.v) {
      // Hand back the rows that changed so the UI can move them out of the bucket.
      const resolved = capped
        .map((id) => ix.cases.get(id))
        .filter((r): r is NonNullable<typeof r> => Boolean(r && r.code && r.source === "description"))
        .map((r) => ({ id: r.id, number: r.number, code: r.code, source: r.source }));
      sse(res, "done", { promoted, scanned, resolved, stats: indexStats(ix) });
    }
  } catch (e) {
    if (!aborted.v) {
      sse(res, "error", {
        kind: e instanceof AuthError ? "auth" : "server",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }
  res.end();
}

// One click can't turn into an unbounded fetch — this is per-case description
// + timeline (3 Creatio requests apiece), not a header-only page.
const DISTRICT_FULL_DETAIL_CAP = 300;

/**
 * Full description + timeline for a whole (already client-filtered) district
 * history in one pass, so it can be read as a single searchable page instead
 * of expanding tickets one at a time. The caller sends back the rows it
 * already has from /api/districts/history — this endpoint only adds the
 * per-case detail (bounded concurrency, matches handleCases/handleTriage).
 */
async function handleDistrictFullDetail(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: any;
  try {
    body = await readBody(req);
  } catch (e) {
    return sendError(res, e);
  }

  const rows: any[] = Array.isArray(body.rows) ? body.rows : [];
  const targets = rows
    .filter(
      (r) =>
        r &&
        typeof r.id === "string" &&
        /^[0-9a-fA-F-]{36}$/.test(r.id) &&
        typeof r.number === "string" &&
        r.number
    )
    .slice(0, DISTRICT_FULL_DETAIL_CAP);

  if (!targets.length) {
    return sendJson(res, 400, { error: "server", message: "No valid case rows supplied." });
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  sse(res, "start", { total: targets.length });

  const aborted = { v: false };
  req.on("close", () => (aborted.v = true));

  let idx = 0;
  let done = 0;
  async function worker(): Promise<void> {
    while (idx < targets.length && !aborted.v) {
      const i = idx++;
      const r = targets[i];
      const stub: CaseRow = {
        Id: r.id,
        Number: r.number,
        Subject: r.subject || "",
        CreatedOn: r.createdOn || "",
        Status: r.status || "",
        Owner: r.owner || "",
        Account: r.accountName || "",
        Contact: "",
        District: typeof r.code === "string" ? r.code : "",
      };
      try {
        const detail = await getCaseDetail(stub, ["description", "timeline"] as DetailKind[]);
        sse(res, "case", { index: i, detail });
      } catch (e) {
        if (e instanceof AuthError) {
          sse(res, "error", { kind: "auth", message: e.message });
          aborted.v = true;
          return;
        }
        sse(res, "case", { index: i, detail: {}, error: e instanceof Error ? e.message : String(e) });
      }
      done++;
      sse(res, "progress", { done, total: targets.length });
    }
  }

  const CONCURRENCY = 4;
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, targets.length) }, () => worker()));
  if (!aborted.v) sse(res, "done", {});
  res.end();
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------
const server = createServer((req, res) => {
  const url = new URL(req.url || "/", `http://${HOST}:${PORT}`);
  if (url.pathname.startsWith("/api/")) {
    handleApi(req, res, url).catch((e) => sendError(res, e));
  } else {
    serveStatic(res, url.pathname).catch(() => {
      res.writeHead(500).end("Internal error");
    });
  }
});

function openBrowser(target: string): void {
  const cmd =
    process.platform === "win32"
      ? `start "" "${target}"`
      : process.platform === "darwin"
        ? `open "${target}"`
        : `xdg-open "${target}"`;
  exec(cmd, () => {
    /* best-effort; ignore if it fails */
  });
}

server.listen(PORT, HOST, () => {
  const target = `http://${HOST}:${PORT}`;
  console.error(`[creatio-app] Case Lookup running at ${target}  (base=${BASE_URL || "unset"})`);
  console.error(`[creatio-app] Press Ctrl+C to stop.`);
  if (process.env.CREATIO_APP_NO_OPEN !== "1") openBrowser(target);
});
