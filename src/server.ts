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
  getAttachments,
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
import {
  applyPlan,
  FixPlanError,
  latestPlan,
  planFix,
  recheckPlan,
} from "./fixPlan.js";
import {
  briefAgeHours,
  buildBrief,
  CaseNumberError,
  getBoundCase,
  loadBrief,
  saveBrief,
  setBoundCase,
  validateCaseNumber,
} from "./caseBrief.js";
import {
  enumerateWorkspaces,
  fileCap,
  getWorkspacePaths,
  indexEntryFor,
  isStale,
  loadAnalysisFor,
  MAX_PATHS,
  saveAssetToWorkspace,
  setWorkspacePaths,
  validateWorkspacePath,
  WorkspacePathError,
  WorkspaceWriteError,
  type AnalysisMode,
  type MultiEnumResult,
} from "./workspace.js";
import { analyzeWorkspace, type CaseScopeInput } from "./analyzeWorkspace.js";
import { computeCaseScope, scopeSummary, type CaseScope } from "./caseScope.js";
import { isCaseAnalysisStale, withCaseFiles } from "./caseFiles.js";
import { getWikiPage, testWiki } from "./adoWiki.js";
import { clipWikiPages } from "./wikiSelect.js";
import type { CaseBrief } from "./caseBrief.js";

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
// Case-scoped workspace helpers
// ---------------------------------------------------------------------------

/** The bound case and its brief, or a user-facing reason there isn't one. */
function boundBrief(): { brief: CaseBrief } | { error: string } {
  const number = getBoundCase();
  if (!number) return { error: "No case is bound. Pick one in phase 1 first." };
  const brief = loadBrief(number);
  if (!brief) {
    return {
      error: `${number} is bound but nothing is stored for it. Search for it in phase 1 and pick it again to fetch the details.`,
    };
  }
  return { brief };
}

/**
 * The census a fix for `caseNumber` may edit: the top-level files plus the
 * files that case's scoped analysis selected in subfolders.
 */
function editableEnumeration(abs: string[], caseNumber: string | null): MultiEnumResult {
  const en = enumerateWorkspaces(abs);
  const ca = caseNumber ? loadAnalysisFor(abs, "case", caseNumber) : null;
  return withCaseFiles(en, ca?.meta.selection, abs);
}

/** Re-load wiki pages a stored case analysis used (from the 24h cache when fresh). */
async function wikiForAnalysis(refs: { path: string; url: string; why: string }[] | undefined) {
  const pages = await Promise.all(
    (refs || []).map(async (r) => {
      try {
        const page = await getWikiPage(r.path);
        return { ...r, content: page.content };
      } catch {
        return null;
      }
    })
  );
  return clipWikiPages(pages.filter((p): p is NonNullable<typeof p> => Boolean(p)));
}

function toScopeInput(scope: CaseScope, brief: CaseBrief): CaseScopeInput {
  return {
    caseNumber: scope.caseNumber,
    terms: scope.terms.map((t) => t.term),
    files: scope.files.map((f) => ({
      rel: f.rel,
      folder: f.folder,
      score: f.score,
      reason: f.reason,
      size: f.size,
      mtime: f.mtime,
      ext: f.ext,
    })),
    wiki: clipWikiPages(scope.wiki).map((w) => ({ path: w.path, url: w.url, why: w.why, content: w.content })),
    wikiSkipped: scope.wikiSkipped,
    briefFetchedAt: brief.fetchedAt,
  };
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
      workspacePaths: getWorkspacePaths(),
      workspaceCap: fileCap(),
      workspaceCase: getBoundCase(),
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

  // Settings: interactive browser login. Opens a real browser at Creatio's
  // login page, waits for the user to sign in, and captures the session
  // cookies — streams progress via SSE since this can take minutes (MFA).
  if (req.method === "POST" && path === "/api/browser-login") {
    await handleBrowserLogin(res);
    return;
  }

  // Settings: can the Azure CLI login read the team wiki?
  if (req.method === "GET" && path === "/api/wiki/test") {
    sendJson(res, 200, await testWiki());
    return;
  }

  // AI analysis of a set of cases — streams the model output via SSE.
  if (req.method === "POST" && path === "/api/analyze") {
    await handleAnalyze(req, res);
    return;
  }

  // -------------------------------------------------------------------------
  // Workspace: the working directory the user is analyzing.
  // -------------------------------------------------------------------------

  // Current workspace config + what's already stored for it.
  if (req.method === "GET" && path === "/api/workspace") {
    const raw = getWorkspacePaths();
    const body: Record<string, unknown> = {
      paths: raw,
      valid: false,
      maxPaths: MAX_PATHS,
      cap: fileCap(),
      aiAvailable: claudeAvailable(),
      analysis: { directory: null, files: [] },
    };
    if (raw.length) {
      try {
        const abs = raw.map(validateWorkspacePath);
        body.paths = abs;
        body.valid = true;
        const entry = indexEntryFor(abs);
        if (entry) body.analysis = { directory: entry.directory, files: entry.files };
        // Flag a stored report that predates the files it describes.
        const stored = loadAnalysisFor(abs, "directory");
        if (stored) {
          try {
            body.stale = isStale(stored.meta, enumerateWorkspaces(abs));
          } catch {
            /* enumeration problems surface on /files */
          }
        }
        // The bound case's scoped analysis, if one exists for these folders.
        const number = getBoundCase();
        const ca = number ? loadAnalysisFor(abs, "case", number) : null;
        if (ca) {
          const brief = loadBrief(number);
          body.caseAnalysis = {
            caseNumber: number,
            finishedAt: ca.meta.finishedAt,
            files: ca.meta.selection || [],
            wikiPages: ca.meta.wikiPages || [],
            wikiSkipped: ca.meta.wikiSkipped || null,
            truncated: ca.meta.truncated,
            stale: isCaseAnalysisStale(ca.meta, brief?.fetchedAt),
          };
        }
      } catch (e) {
        body.error = e instanceof Error ? e.message : String(e);
      }
    }
    sendJson(res, 200, body);
    return;
  }

  // Save the workspace folders to .env (takes effect immediately — read live).
  // Each path is validated individually so the UI can point at the bad one.
  if (req.method === "POST" && path === "/api/workspace") {
    try {
      const requestBody = await readBody(req);
      const incoming: string[] = Array.isArray(requestBody.paths)
        ? requestBody.paths
        : typeof requestBody.path === "string"
          ? [requestBody.path]
          : [];
      const trimmed = incoming
        .map((p) => (typeof p === "string" ? p.trim() : ""))
        .filter(Boolean)
        .slice(0, MAX_PATHS);

      // Clearing is explicit rather than "save nothing", so an empty form can
      // still be rejected as a mistake. Stored analyses are left on disk: they
      // are keyed by folder, so re-entering the same path brings its report
      // back instead of costing another run.
      if (requestBody.clear === true) {
        setWorkspacePaths([]);
        sendJson(res, 200, { saved: true, cleared: true, paths: [], enumeration: null });
        return;
      }

      if (!trimmed.length) {
        sendJson(res, 400, { error: "path", message: "Enter the folder you're working in." });
        return;
      }

      const abs: string[] = [];
      for (let i = 0; i < trimmed.length; i++) {
        try {
          const one = validateWorkspacePath(trimmed[i]);
          // Silently collapse a folder listed twice rather than double-counting
          // its files against the cap.
          if (!abs.some((p) => p.toLowerCase() === one.toLowerCase())) abs.push(one);
        } catch (e) {
          if (e instanceof WorkspacePathError) {
            // `index` lets the UI mark the offending box instead of the first one.
            sendJson(res, 400, { error: "path", index: i, message: e.message });
            return;
          }
          throw e;
        }
      }

      setWorkspacePaths(abs);
      sendJson(res, 200, { saved: true, paths: abs, enumeration: enumerateWorkspaces(abs) });
    } catch (e) {
      sendError(res, e);
    }
    return;
  }

  // Census of the top-level source files — drives the count and the over-cap choice.
  if (req.method === "GET" && path === "/api/workspace/files") {
    try {
      const qp = url.searchParams.getAll("path");
      const abs = (qp.length ? qp : getWorkspacePaths()).map(validateWorkspacePath);
      if (!abs.length) {
        sendJson(res, 400, { error: "path", message: "No workspace folder configured." });
        return;
      }
      sendJson(res, 200, enumerateWorkspaces(abs));
    } catch (e) {
      if (e instanceof WorkspacePathError) {
        sendJson(res, 400, { error: "path", message: e.message });
        return;
      }
      sendError(res, e);
    }
    return;
  }

  // Read back a stored analysis.
  if (req.method === "GET" && path === "/api/workspace/analysis") {
    try {
      const qp = url.searchParams.getAll("path");
      const abs = (qp.length ? qp : getWorkspacePaths()).map(validateWorkspacePath);
      const mode = (url.searchParams.get("mode") || "directory") as AnalysisMode;
      const file = url.searchParams.get("file") || undefined;
      const loaded = loadAnalysisFor(
        abs,
        mode === "file" || mode === "case" ? mode : "directory",
        mode === "case" ? getBoundCase() : file
      );
      if (!loaded) {
        sendJson(res, 404, { error: "not_found", message: "No stored analysis for that folder." });
        return;
      }
      sendJson(res, 200, { meta: loaded.meta, markdown: loaded.body });
    } catch (e) {
      if (e instanceof WorkspacePathError) {
        sendJson(res, 400, { error: "path", message: e.message });
        return;
      }
      sendError(res, e);
    }
    return;
  }

  // Instant, model-free preview of what a case-scoped analysis would read:
  // the case keywords, the related files (searched recursively) and the
  // matching team-wiki pages.
  if (req.method === "GET" && path === "/api/workspace/case-scope") {
    try {
      const bb = boundBrief();
      if ("error" in bb) {
        sendJson(res, 400, { error: "case", message: bb.error });
        return;
      }
      const abs = getWorkspacePaths().map(validateWorkspacePath);
      if (!abs.length) {
        sendJson(res, 400, { error: "path", message: "No workspace folder configured." });
        return;
      }
      const scope = await computeCaseScope(bb.brief, abs, { wiki: url.searchParams.get("wiki") !== "0" });
      sendJson(res, 200, scopeSummary(scope));
    } catch (e) {
      if (e instanceof WorkspacePathError) {
        sendJson(res, 400, { error: "path", message: e.message });
        return;
      }
      sendError(res, e);
    }
    return;
  }

  // Read-only analysis of the workspace — streams the report via SSE.
  if (req.method === "POST" && path === "/api/workspace/analyze") {
    await handleWorkspaceAnalyze(req, res);
    return;
  }

  // -------------------------------------------------------------------------
  // The bound case — phase 1 of the Workspace tab.
  //
  // The binding lives in .env and the fetched brief in .analysis/cases/, so it
  // survives a browser reload and is readable by the creatio-case-fix skill in
  // a fresh Claude Code session. The server itself stays stateless.
  // -------------------------------------------------------------------------

  if (req.method === "GET" && path === "/api/workspace/case") {
    const number = getBoundCase();
    const brief = number ? loadBrief(number) : null;
    sendJson(res, 200, {
      number,
      brief,
      ageHours: brief ? Math.round(briefAgeHours(brief) * 10) / 10 : null,
    });
    return;
  }

  // Bind a case (or clear the binding with an empty number).
  //
  // The case is re-fetched from Creatio by number rather than trusting the row
  // the browser posted: the brief is the artifact the fix skill acts on, so it
  // has to come from the source.
  if (req.method === "POST" && path === "/api/workspace/case") {
    try {
      const requestBody = await readBody(req);
      const raw = typeof requestBody.number === "string" ? requestBody.number.trim() : "";

      if (!raw) {
        setBoundCase("");
        sendJson(res, 200, { saved: true, number: "", brief: null, ageHours: null });
        return;
      }

      const number = validateCaseNumber(raw);
      const found = await findCases({ mode: "number", numbers: [number] });
      const row = found.cases[0];
      if (!row) {
        sendJson(res, 404, {
          error: "not_found",
          message: `No case with number ${number}. Check the number, or search by owner instead.`,
        });
        return;
      }

      const detail = await getCaseDetail(row, ["description", "timeline"]);

      // Attachments need CaseFile in the entity allowlist. A missing entry must
      // not fail the bind — the brief records it as a caveat instead.
      let attachments: Awaited<ReturnType<typeof getAttachments>> | null = null;
      try {
        attachments = await getAttachments(row.Id);
      } catch (e) {
        if (e instanceof AuthError) throw e;
      }

      const brief = buildBrief(row, detail, attachments);
      saveBrief(brief);
      setBoundCase(brief.number);

      sendJson(res, 200, { saved: true, number: brief.number, brief, ageHours: 0 });
    } catch (e) {
      if (e instanceof CaseNumberError) {
        sendJson(res, 400, { error: "case", message: e.message });
        return;
      }
      sendError(res, e);
    }
    return;
  }

  // Save a case attachment (an image — e.g. the school's logo) into one of the
  // configured workspace folders, so the template can actually use it.
  //
  // This writes outside the repo, so every rule lives in workspace.ts: images
  // only, the folder must be one that's configured, the client-supplied name is
  // reduced to a safe basename, and replacing an existing file needs an
  // explicit confirm and backs the original up first.
  if (req.method === "POST" && path === "/api/workspace/attachment") {
    try {
      const requestBody = await readBody(req);
      const id = typeof requestBody.id === "string" ? requestBody.id : "";
      if (!/^[0-9a-fA-F-]{36}$/.test(id)) {
        sendJson(res, 400, { error: "server", message: "Invalid attachment id." });
        return;
      }

      const allowed = getWorkspacePaths().map(validateWorkspacePath);
      if (!allowed.length) {
        sendJson(res, 400, {
          error: "path",
          message: "No workspace folder is configured — set one in phase 2 first.",
        });
        return;
      }

      const file = await downloadFile("CaseFile", id);
      const saved = saveAssetToWorkspace(
        typeof requestBody.folder === "string" && requestBody.folder ? requestBody.folder : allowed[0],
        typeof requestBody.name === "string" && requestBody.name ? requestBody.name : file.filename || "",
        file.buffer,
        { overwrite: requestBody.overwrite === true, allowed }
      );

      sendJson(res, 200, {
        saved: true,
        name: saved.name,
        path: saved.path,
        bytes: file.buffer.length,
        overwrote: saved.overwrote,
        backup: saved.backup || null,
      });
    } catch (e) {
      if (e instanceof WorkspaceWriteError) {
        // `code` lets the UI offer a replace instead of just reporting a wall.
        sendJson(res, 400, { error: "asset", code: e.code, message: e.message });
        return;
      }
      if (e instanceof WorkspacePathError) {
        sendJson(res, 400, { error: "path", message: e.message });
        return;
      }
      sendError(res, e);
    }
    return;
  }

  // -------------------------------------------------------------------------
  // Phase 3: plan a fix, then apply it on approval.
  //
  // The planning run has NO write tools; applying is done by plain Node in
  // fixPlan.ts after the user approves and every match is re-verified. See that
  // module's header for why the split is the security model.
  // -------------------------------------------------------------------------

  // The last plan for the bound case, so a browser reload doesn't lose it.
  if (req.method === "GET" && path === "/api/workspace/fix") {
    const number = getBoundCase();
    let plan = number ? latestPlan(number) : null;
    // Re-check against the files as they are now — a plan read back later is a
    // claim about the past, and the review screen must show current reality.
    if (plan) {
      try {
        const abs = getWorkspacePaths().map(validateWorkspacePath);
        if (abs.length) plan = recheckPlan(plan, editableEnumeration(abs, plan.caseNumber), abs);
      } catch {
        /* unreadable workspace — hand back the stored plan as-is */
      }
    }
    sendJson(res, 200, { plan });
    return;
  }

  if (req.method === "POST" && path === "/api/workspace/fix/plan") {
    await handleFixPlan(req, res);
    return;
  }

  // Apply takes only a plan ID — never the edits themselves. The server re-reads
  // the plan it wrote, so the browser can't ask for an arbitrary file write.
  if (req.method === "POST" && path === "/api/workspace/fix/apply") {
    try {
      const requestBody = await readBody(req);
      const id = typeof requestBody.id === "string" ? requestBody.id : "";
      if (!id) {
        sendJson(res, 400, { error: "server", message: "No plan id given." });
        return;
      }
      const abs = getWorkspacePaths().map(validateWorkspacePath);
      if (!abs.length) {
        sendJson(res, 400, { error: "path", message: "No workspace folder configured." });
        return;
      }
      const caseNumber = /^SR\d{4,12}(?=-)/.exec(id)?.[0] || null;
      const result = applyPlan(id, editableEnumeration(abs, caseNumber), abs, {
        reapply: requestBody.reapply === true,
      });
      sendJson(res, 200, { applied: result.applied, backupDir: result.backupDir });
    } catch (e) {
      if (e instanceof FixPlanError) {
        sendJson(res, 400, { error: "fix", message: e.message });
        return;
      }
      if (e instanceof WorkspacePathError) {
        sendJson(res, 400, { error: "path", message: e.message });
        return;
      }
      sendError(res, e);
    }
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

async function handleBrowserLogin(res: ServerResponse): Promise<void> {
  // Read the base URL from .env rather than the startup constant so a URL the
  // user just saved in Settings works without restarting the app.
  const baseUrl = (readEnvFile().CREATIO_BASE_URL || BASE_URL || "").replace(/\/+$/, "");
  if (!baseUrl) {
    return sendJson(res, 400, {
      error: "server",
      message: "Set the Creatio base URL first, then log in.",
    });
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  try {
    // Imported lazily so a missing/broken playwright-core only breaks login
    // rather than stopping the whole app from starting.
    const { loginViaBrowser, LoginCancelledError } = await import("./browserLogin.js");
    try {
      const cookies = await loginViaBrowser(baseUrl, (message) => sse(res, "progress", { message }));
      const updates: Record<string, string> = {
        CREATIO_ASPXAUTH: cookies.aspx,
        CREATIO_BPMCSRF: cookies.csrf,
      };
      // BPMLOADER is optional — don't blank an existing value if it wasn't set.
      if (cookies.loader) updates.CREATIO_BPMLOADER = cookies.loader;
      writeEnvFile(updates);

      sse(res, "progress", { message: "Verifying connection…" });
      // The login browser has only just shut down; the first probe out of Node
      // can catch a transient socket/DNS blip (undici surfaces those as a bare
      // "fetch failed"). One retry keeps a blip from looking like a hard failure.
      let connection = await testConnection();
      if (!connection.ok) {
        await new Promise((r) => setTimeout(r, 1500));
        connection = await testConnection();
      }
      sse(res, "done", { connection });
    } catch (e) {
      const cancelled = e instanceof LoginCancelledError;
      sse(res, "error", {
        kind: cancelled ? "cancelled" : "server",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  } catch (e) {
    sse(res, "error", {
      kind: "server",
      message:
        "Browser login is unavailable — playwright-core failed to load. Run `npm install`. " +
        (e instanceof Error ? e.message : String(e)),
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

/**
 * Read-only analysis of the workspace directory (Server-Sent Events).
 *
 * Every validation happens BEFORE writeHead, so a bad request gets a real JSON
 * error the UI can render rather than an error buried inside an open stream.
 *
 * The file cap is enforced HERE as well as in the UI — the browser's decision is
 * not trusted, so a direct API call can't kick off a huge run either.
 */
async function handleWorkspaceAnalyze(req: IncomingMessage, res: ServerResponse): Promise<void> {
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
        "The Claude CLI was not found. Install it (npm i -g @anthropic-ai/claude-code), run `claude` once to log in, then restart the app.",
    });
  }

  let abs: string[];
  let en: MultiEnumResult;
  try {
    const incoming: string[] = Array.isArray(body.paths)
      ? body.paths
      : typeof body.path === "string" && body.path
        ? [body.path]
        : getWorkspacePaths();
    abs = incoming
      .map((p) => (typeof p === "string" ? p.trim() : ""))
      .filter(Boolean)
      .slice(0, MAX_PATHS)
      .map(validateWorkspacePath);
    if (!abs.length) {
      return sendJson(res, 400, { error: "path", message: "No workspace folder configured." });
    }
    en = enumerateWorkspaces(abs);
  } catch (e) {
    if (e instanceof WorkspacePathError) {
      return sendJson(res, 400, { error: "path", message: e.message });
    }
    return sendError(res, e);
  }

  const mode: AnalysisMode = body.mode === "file" ? "file" : body.mode === "case" ? "case" : "directory";
  let target: string | undefined;
  let targetFolder: string | undefined;
  let scope: CaseScope | undefined;
  let scopeInput: CaseScopeInput | undefined;

  if (mode === "case") {
    // The case scope is computed here, before the stream opens, so a missing
    // case or an empty selection is a normal JSON error. The cap is not
    // checked: the selection is already bounded by it.
    const bb = boundBrief();
    if ("error" in bb) return sendJson(res, 400, { error: "case", message: bb.error });
    try {
      scope = await computeCaseScope(bb.brief, abs);
    } catch (e) {
      return sendError(res, e);
    }
    if (!scope.files.length) {
      return sendJson(res, 400, {
        error: "no_match",
        message:
          `No files in the workspace matched ${bb.brief.number}'s keywords (${scope.terms
            .slice(0, 6)
            .map((t) => t.term)
            .join(", ") || "none found"}). Analyze the whole folder instead, or add the folder that holds this school's files.`,
        scope: scopeSummary(scope),
      });
    }
    scopeInput = toScopeInput(scope, bb.brief);
  } else if (mode === "file") {
    // Exact match against the enumeration — never join a raw name onto a path.
    // This is also what disposes of any "../" concern.
    target = typeof body.file === "string" ? body.file : "";
    targetFolder = typeof body.folder === "string" ? body.folder : undefined;
    const hit = en.files.find(
      (f) => f.name === target && (!targetFolder || f.folder === targetFolder)
    );
    if (!target || !hit) {
      return sendJson(res, 400, {
        error: "server",
        message: `"${target || ""}" is not one of the top-level source files in the workspace.`,
        files: en.files,
      });
    }
    targetFolder = hit.folder;
  } else {
    if (en.count === 0) {
      return sendJson(res, 400, {
        error: "server",
        message: "No top-level source or text files found in that folder.",
      });
    }
    if (en.overCap && !body.force) {
      return sendJson(res, 400, {
        error: "over_cap",
        message:
          `That folder has ${en.count} top-level files — more than the ${en.cap}-file quick-analysis limit. ` +
          "Choose to analyze all of them anyway, or pick a single file.",
        count: en.count,
        cap: en.cap,
        files: en.files,
      });
    }
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  sse(res, "start", {
    paths: abs,
    mode,
    target: target || null,
    targetFolder: targetFolder || null,
    count: mode === "file" ? 1 : mode === "case" ? scope!.files.length : en.count,
    cap: en.cap,
    overCap: en.overCap,
    skipped: en.skipped,
  });
  if (scope) sse(res, "scope", scopeSummary(scope));

  // A tool-using run can sit silent for a minute while the model reads files.
  // A bare SSE comment keeps proxies and the fetch reader alive; the client's
  // consumeSse finds no `data:` in the block and skips it.
  const heartbeat = setInterval(() => {
    res.write(": ping\n\n");
  }, 15_000);

  const controller = new AbortController();
  let closed = false;

  const runner = analyzeWorkspace(
    {
      paths: abs,
      mode,
      target,
      targetFolder,
      enumeration: en,
      proceededOverCap: mode === "directory" && en.overCap && Boolean(body.force),
      caseScope: scopeInput,
      signal: controller.signal,
    },
    {
      onChunk: (text) => sse(res, "chunk", { text }),
      onToolUse: (t) => sse(res, "tool", { name: t.name, target: t.target }),
      onDone: ({ meta, stored, costUsd, totalTokens, durationMs }) => {
        clearInterval(heartbeat);
        sse(res, "done", {
          costUsd,
          totalTokens,
          durationMs,
          saved: Boolean(stored),
          report: stored?.report || null,
          truncated: meta.truncated,
          filesAnalyzed: meta.filesAnalyzed.length,
          toolCalls: meta.toolCalls.length,
        });
        res.end();
      },
      onError: (err, partial) => {
        clearInterval(heartbeat);
        sse(res, "error", {
          kind: err.kind,
          message: err.message,
          saved: Boolean(partial?.stored),
          report: partial?.stored?.report || null,
        });
        res.end();
      },
    }
  );

  req.on("close", () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    controller.abort();
    runner.kill();
  });
}

/**
 * Plan a fix for the bound case (Server-Sent Events).
 *
 * Read-only: the child gets Read/Glob/Grep and nothing else, so this route
 * cannot modify a file no matter what the case text says. It streams the
 * explanation, then a `done` event carrying the structured plan for review.
 *
 * All validation happens before writeHead, so a missing case or folder is a
 * real JSON error rather than one buried inside an open stream.
 */
async function handleFixPlan(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    await readBody(req);
  } catch (e) {
    return sendError(res, e);
  }

  if (!claudeAvailable()) {
    return sendJson(res, 400, {
      error: "server",
      message:
        "The Claude CLI was not found. Install it (npm i -g @anthropic-ai/claude-code), run `claude` once to log in, then restart the app.",
    });
  }

  const number = getBoundCase();
  if (!number) {
    return sendJson(res, 400, {
      error: "server",
      message: "No case is bound. Pick one in phase 1 first.",
    });
  }
  const brief = loadBrief(number);
  if (!brief) {
    return sendJson(res, 400, {
      error: "server",
      message: `${number} is bound but nothing is stored for it. Search for it in phase 1 and pick it again to fetch the details.`,
    });
  }

  let abs: string[];
  let en: MultiEnumResult;
  try {
    abs = getWorkspacePaths().map(validateWorkspacePath);
    if (!abs.length) {
      return sendJson(res, 400, { error: "path", message: "No workspace folder configured." });
    }
    // Includes the case analysis's selected subfolder files, so they're editable.
    en = editableEnumeration(abs, number);
  } catch (e) {
    if (e instanceof WorkspacePathError) {
      return sendJson(res, 400, { error: "path", message: e.message });
    }
    return sendError(res, e);
  }

  if (!en.count) {
    return sendJson(res, 400, {
      error: "server",
      message: "No top-level source files in the workspace, so there is nothing to fix.",
    });
  }

  // The stored workspace analysis is the planner's map: it says what each file
  // is for, so the run spends its budget reading the right files rather than
  // rediscovering the layout. Staleness is passed through so it can be weighed
  // rather than silently trusted.
  //
  // The case-scoped analysis for this case wins when there is one: it was
  // built from exactly the files this case touches, plus the team wiki.
  const caseStored = loadAnalysisFor(abs, "case", number);
  const stored = caseStored || loadAnalysisFor(abs, "directory");
  let analysisStale = false;
  if (caseStored) {
    analysisStale = isCaseAnalysisStale(caseStored.meta, brief.fetchedAt);
  } else if (stored) {
    try {
      analysisStale = isStale(stored.meta, enumerateWorkspaces(abs));
    } catch {
      /* enumeration already succeeded above; treat as current */
    }
  }
  const wiki = caseStored ? await wikiForAnalysis(caseStored.meta.wikiPages) : [];

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  sse(res, "start", {
    caseNumber: brief.number,
    caseSubject: brief.subject,
    paths: abs,
    files: en.count,
    hasAnalysis: Boolean(stored),
    analysisGenerated: stored?.meta.finishedAt || null,
    analysisStale,
    analysisFiles: stored?.meta.filesAnalyzed.length || 0,
    analysisMode: stored?.meta.mode || null,
    wikiPages: wiki.map(({ path, url }) => ({ path, url })),
  });

  const heartbeat = setInterval(() => {
    res.write(": ping\n\n");
  }, 15_000);

  const controller = new AbortController();
  let closed = false;

  const runner = planFix(
    {
      paths: abs,
      enumeration: en,
      brief,
      analysisMarkdown: stored?.body,
      analysisGenerated: stored?.meta.finishedAt,
      analysisStale,
      wiki,
      signal: controller.signal,
    },
    {
      onChunk: (text) => sse(res, "chunk", { text }),
      onToolUse: (t) => sse(res, "tool", { name: t.name, target: t.target }),
      onDone: ({ plan, planError, costUsd, totalTokens, durationMs }) => {
        clearInterval(heartbeat);
        sse(res, "done", { plan, planError: planError || null, costUsd, totalTokens, durationMs });
        res.end();
      },
      onError: (err, _partial, salvaged) => {
        clearInterval(heartbeat);
        // A timed-out or stopped run that already emitted its plan still has
        // something reviewable; flag it as incomplete rather than discarding it.
        sse(res, "error", {
          kind: err.kind,
          message: err.message,
          plan: salvaged,
          incomplete: Boolean(salvaged),
        });
        res.end();
      },
    }
  );

  req.on("close", () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    controller.abort();
    runner.kill();
  });
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
