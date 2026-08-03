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
import { readFile } from "node:fs/promises";
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
  testConnection,
  downloadFile,
  FILE_DOWNLOAD_ENTITIES,
} from "./creatioClient.js";
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
  type AnalyzableCase,
  type Preset,
} from "./analyze.js";
import { buildIndex, toAbs, isKnownFile, REPO_ROOT, type RepoIndex } from "./repoIndex.js";
import { guessDistricts } from "./districtMap.js";
import { triageCase, type CaseBrief } from "./triage.js";

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
    res.writeHead(200, { "Content-Type": type }).end(data);
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
    sendJson(res, 200, {
      baseUrl: BASE_URL,
      allowlist: ALLOWED_ENTITIES,
      maxTop: MAX_TOP,
      statuses: STATUS_NAMES,
      openActive: OPEN_ACTIVE,
      aiAvailable: claudeAvailable(),
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
    const guesses = guessDistricts(ix, {
      accountName: c.Account,
      subject: c.Subject,
      descriptionText: c.detail?.description || "",
    });
    sse(res, "progress", {
      phase: "triage",
      done: i,
      total: detailed.length,
      caseNumber: c.Number,
    });

    const brief = await new Promise<CaseBrief | null>((resolve) => {
      current = triageCase(
        { case: c, index: ix, guesses, model: process.env.CREATIO_APP_MODEL || undefined },
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
      });
    }
    sse(res, "progress", { phase: "triage", done: i + 1, total: detailed.length });
  }

  if (!aborted.v) sse(res, "done", { total: detailed.length });
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
