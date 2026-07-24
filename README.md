# Creatio Case Toolkit

A **read-only** toolkit for working with Creatio Support cases:

- an **MCP server** that exposes Creatio's OData API to AI clients (Claude Code, Claude Desktop, …), and
- a **local web app** that lets non-technical users look up cases by clicking menus — with descriptions, conversation timelines, inline attachments, and optional **AI analysis** powered by the Claude CLI.

Everything is read-only by construction: the HTTP layer only ever issues `GET`, there are no create/update/delete paths, and an entity allowlist + row cap keep the blast radius small. Safe to point at production.

> **Status:** early/active. Read-only today; a gated **write-back** capability (draft & post case updates with human approval) is on the [roadmap](#roadmap).

---

## Features

- 🔒 **Read-only by design** — GET-only client, no write tools, entity allowlist, `$top` clamp.
- 🧰 **MCP server** — `creatio_query_records`, `creatio_get_record`, `creatio_list_allowed_entities`.
- 🖥️ **Local web app** — look up cases by owner, case number, account, or "all recent"; filter by status; choose detail depth.
- 🧵 **Rich case detail** — HTML-stripped descriptions, merged **feed + email timeline**, and **inline screenshots/attachments** proxied from Creatio's FileService.
- ✨ **AI analysis (optional)** — Summarize & prioritize, Common themes, Next actions, or free-text Q&A over the loaded cases; streamed live via the local Claude CLI (uses your existing Claude login — no API key).
- ⚙️ **In-app settings** — paste/refresh SSO cookies, base URL, allowlist, row cap; no VS Code required.
- 📡 **Live progress** — the search streams per-case progress with a percentage bar.

## Repository layout

```
src/
  creatioClient.ts   Shared read-only OData client (auth, cookies, GET, file download)
  caseLookup.ts      Case-lookup query recipes (search, description, timeline, attachments)
  analyze.ts         Claude CLI runner for AI analysis (streaming, isolated, no tools/MCP)
  server.ts          Local web app: static hosting + JSON/SSE API
  index.ts           MCP server (thin surface over creatioClient)
  test-auth.ts       Standalone credential check
public/              Web app UI (vanilla HTML/CSS/JS, zero runtime deps)
start-app.bat        One-click launcher for the web app (Windows)
.env.example         Copy to .env and fill in
```

---

## Quick start

**Prerequisites:** Node.js 18+ (developed on Node 24).

```bash
git clone <your-repo-url> creatio-case-toolkit
cd creatio-case-toolkit
npm install
npm run build
cp .env.example .env      # then edit .env (see Configuration)
npm run test-auth         # confirm credentials work (✔ Success)
```

**Run the web app:**

```bash
npm run app               # builds, starts the server, opens http://127.0.0.1:3000
```

On Windows you can just double-click **`start-app.bat`**.

**Register the MCP server** in Claude Code (see [MCP server](#mcp-server) for `.mcp.json` form):

```bash
claude mcp add creatio-readonly \
  --env CREATIO_BASE_URL=https://<your-tenant>.creatio.com \
  --env CREATIO_ALLOWED_ENTITIES=Case,Activity,Contact,Account,SocialMessage \
  -- node ./dist/index.js
```

---

## Configuration

All settings live in `.env` (and, for the MCP server, in its client registration). **Never commit `.env`** — it holds live credentials/cookies (it's git-ignored by default).

| Variable | Purpose |
|---|---|
| `CREATIO_BASE_URL` | Your Creatio URL, e.g. `https://<your-tenant>.creatio.com` |
| `CREATIO_LOGIN` / `CREATIO_PASSWORD` | Forms-auth service account (Mode 1) |
| `CREATIO_ASPXAUTH` / `CREATIO_BPMCSRF` / `CREATIO_BPMLOADER` | SSO session cookies (Mode 2) |
| `CREATIO_ALLOWED_ENTITIES` | Comma-separated entity allowlist (e.g. `Case,Activity,Contact,Account,SocialMessage`) |
| `CREATIO_MAX_TOP` | Max rows per query (default 50) |
| `CREATIO_APP_PORT` | Web app port (default 3000) |
| `CREATIO_APP_NO_OPEN` | Set `1` to stop the app auto-opening the browser |
| `CREATIO_APP_MODEL` | Model for AI analysis (e.g. `sonnet`, `haiku`); default = your CLI default |

### Authentication

The client auto-selects a mode based on which vars are set.

- **Mode 1 — Forms auth (recommended):** a **local**, least-privilege, read-only Creatio service account (`CREATIO_LOGIN` + `CREATIO_PASSWORD`). Re-authenticates automatically on expiry.
- **Mode 2 — Cookie auth (SSO tenants):** paste a browser session's cookies (`.ASPXAUTH`, `BPMCSRF`, `BPMLOADER`) from **DevTools → Application → Cookies**. Cookies expire in hours; refresh them in `.env` or the app's **Settings** tab and the next query picks them up — **no restart needed**.

Verify either mode with `npm run test-auth`.

---

## Web app

- **Lookup tab** — choose *who* (assignee / case number / account / all recent), *which statuses*, and *how much detail* (summary, full description, timeline, latest update, extra fields), then **Search**. Results stream in with a progress bar.
- **Attachments** — screenshots embedded in descriptions and feed posts render **inline** (click to enlarge); email attachments appear as thumbnails. Images are streamed through a read-only `/api/file` proxy restricted to file entities + GUID ids.
- **Settings tab** — base URL, cookies, allowlist, row cap, plus **Test connection**.

The server binds to `127.0.0.1` only and the only file it ever writes is your local `.env`.

### AI analysis

With the **Claude CLI** installed and logged in, the results view shows an **"Analyze with AI"** bar — Summarize & prioritize, Common themes, Next actions, or a free-text question, streamed live and rendered as Markdown (copy / download as `.md`). Tick row checkboxes to analyze a subset; each row also has a "✨ analyze this one" button.

- Enable: `npm i -g @anthropic-ai/claude-code`, then run `claude` once to sign in. Uses **your Claude subscription — no API key**.
- Runs `claude -p` locally, **isolated** (no tools, no MCP, empty temp cwd); only the selected cases' **text** is sent — never your cookies. Set `CREATIO_APP_MODEL=sonnet` (or `haiku`) for cheaper/faster runs.

---

## MCP server

| Tool | Description |
|---|---|
| `creatio_list_allowed_entities` | Show base URL, allowlist, and row cap |
| `creatio_query_records` | OData query (`$filter`, `$select`, `$orderby`, `$top`, `$expand`) |
| `creatio_get_record` | Fetch one record by GUID |

`.mcp.json` form:

```json
{
  "mcpServers": {
    "creatio-readonly": {
      "command": "node",
      "args": ["./dist/index.js"],
      "env": {
        "CREATIO_BASE_URL": "https://<your-tenant>.creatio.com",
        "CREATIO_ALLOWED_ENTITIES": "Case,Activity,Contact,Account,SocialMessage",
        "CREATIO_MAX_TOP": "50"
      }
    }
  }
}
```

> Foreign keys like `OwnerId`/`AccountId`/`StatusId` are **not** filterable — filter through navigation paths (`Owner/Id`, `Account/Id`, `Status/Name`). See `CASE-QUERY-REFERENCE.md` for the full query recipes and gotchas.

---

## Security & data handling

- **Read-only:** the client issues HTTP `GET` only; there is no write path to Creatio anywhere in the codebase.
- **Local & single-user:** the web app binds to `127.0.0.1`, with no app-level auth by design.
- **Secrets stay local:** cookies/credentials live in `.env` (git-ignored) and are masked in the UI; AI analysis receives only case **text**, never cookies.
- **Bounded reach:** entity allowlist + `$top` clamp; the file proxy is limited to a fixed set of file entities and GUID ids.

---

## Roadmap

- **✍️ Write-back (Stage 3):** draft case replies / status updates with AI, then post them to Creatio **on explicit human approval**, and verify the write succeeded. This is the planned next step and will be gated, audited, and opt-in — the read-only default stays.
- OAuth 2.0 client-credentials auth for unattended SSO use.
- Pagination past the 50-row cap in the UI; attachment-count badges.
- Optional `ActivityFile` inline email images.

**Agentic maturity:** today the toolkit is **Stage 2 — Multi-Step** (multi-step, multi-tool, read-only "generate but don't run"); the in-app Analyze feature is **Stage 1 — Guided Task**. Write-back is what moves it into **Stage 3 — Autonomous Workflow**.

---

## Scripts

| Script | Does |
|---|---|
| `npm run build` | Compile TypeScript to `dist/` |
| `npm run app` | Build + start the web app |
| `npm start` | Start the MCP server (stdio) |
| `npm run test-auth` | Verify credentials without starting anything |

## License

_Add a license (e.g. MIT) before publishing._
