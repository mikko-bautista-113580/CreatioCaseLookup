# Creatio Case Toolkit

A **read-only** toolkit for working with Creatio Support cases:

- an **MCP server** that exposes Creatio's OData API to AI clients (Claude Code, Claude Desktop, …), and
- a **local web app** that lets non-technical users look up cases by clicking menus — with descriptions, conversation timelines, inline attachments, and optional **AI analysis** powered by the Claude CLI.

Creatio access is read-only by construction: the HTTP layer only ever issues `GET`, there are no create/update/delete paths, and an entity allowlist + row cap keep the blast radius small. Safe to point at production. The only thing that ever writes anywhere is the opt-in **Work on a case** flow, and it writes locally — uncommitted edits in your `custom-reports` working tree, behind an explicit approval click.

> **Status:** early/active. Read-only today; a gated **write-back** capability (draft & post case updates with human approval) is on the [roadmap](#roadmap).

📐 **Working on the tool itself?** [**ARCHITECTURE.md**](ARCHITECTURE.md) is the developer
guide — the two-stage agent pipeline and the trust asymmetry it is built around, the
module map, the route and SSE reference, the security model, and a list of the known
defects and rough edges worth knowing before you touch anything.

---

## Features

- 🔒 **Read-only by design** — GET-only client, no write tools, entity allowlist, `$top` clamp.
- 🧰 **MCP server** — `creatio_query_records`, `creatio_get_record`, `creatio_list_allowed_entities`, plus `creatio_list_districts`, `creatio_district_history`, `creatio_case_district`.
- 🖥️ **Local web app** — look up cases by owner, case number, account, or "all recent"; filter by status; choose detail depth.
- 🏫 **Cases by SIS district** — group tickets by `Account.NltDistrictCode` and read a district's full history, so "has this district reported this before?" is one click.
- 🧵 **Rich case detail** — HTML-stripped descriptions, merged **feed + email timeline**, and **inline screenshots/attachments** proxied from Creatio's FileService.
- 🎫 **Ticket viewer** — every results row (Lookup and Districts) has a 🎫 button that opens the full case page in an overlay — profile fields, description, and conversation, like the Creatio case card but faster; detail is fetched on demand and cached so reopening is instant.
- ✨ **AI analysis (optional)** — Summarize & prioritize, Common themes, Next actions, or free-text Q&A over the loaded cases; streamed live via the local Claude CLI (uses your existing Claude login — no API key).
- 🔧 **Work on a case (optional, gated)** — one click triages a case to candidate `custom-reports` files, shows you the validated brief, and only after you approve spawns an edit-capable agent that reads the repo READMEs/CLAUDE.md first, fixes the defect inside the implicated district folders only, and leaves everything **uncommitted** for you to review and finalize. No git access, no shell, full audit trail.
- ⚙️ **In-app settings** — paste/refresh SSO cookies, base URL, allowlist, row cap; no VS Code required.
- 📡 **Live progress** — the search streams per-case progress with a percentage bar.

## Repository layout

```
src/
  creatioClient.ts   Shared read-only OData client (auth, cookies, GET, file download, bulk paging)
  caseLookup.ts      Case-lookup query recipes (search, description, timeline, attachments)
  districtIndex.ts   Cached case index grouped by SIS district code (Account.NltDistrictCode)
  analyze.ts         Claude CLI runner for AI analysis (streaming, isolated, no tools/MCP)
  repoIndex.ts       Deterministic file index over custom-reports (path validation lives here)
  districtMap.ts     Case metadata -> candidate district codes
  triage.ts          Stage A: case -> validated CaseBrief (isolated agent, no tools)
  workOn.ts          Read-only plan pass, then Stage B: brief + approved plan ->
                     scoped, uncommitted edits + git change report
  audit.ts           Append-only NDJSON audit log (.audit/)
  shared/claudeRun.ts  Shared Claude CLI spawner (the injection boundary)
  server.ts          Local web app: static hosting + JSON/SSE API
  index.ts           MCP server (thin surface over creatioClient + the district index)
  test-auth.ts       Standalone credential check
public/              Web app UI (vanilla HTML/CSS/JS, zero runtime deps)
start-app.bat        One-click launcher for the web app (Windows)
dev-app.bat          Same app in watch mode — rebuilds + restarts on every src/ save
.env.example         Copy to .env and fill in
.cache/              Local indexes (gitignored) — repo-index.json, district-cases.json
```

---

## Quick start

**Prerequisites:** Node.js 18+ (developed on Node 26.1).

> Behind a TLS-inspecting corporate proxy, always launch through the npm scripts — they
> pass `--use-system-ca`, without which Node 26 ignores the Windows certificate store and
> every Creatio request fails with a bare `TypeError: fetch failed`. See
> [ARCHITECTURE.md § defects](ARCHITECTURE.md#defects).

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

**While making changes to the tool** — double-click **`dev-app.bat`** instead. It opens
two windows (the TypeScript compiler and the server) and reloads by itself:

| You changed | What's needed |
|---|---|
| `public/*` — `app.js`, `styles.css`, `index.html` | Nothing. Refresh the browser (files are read from disk per request and sent `no-store`). |
| `src/*.ts` | Nothing under `dev-app.bat` — it recompiles and restarts the server in ~1-2s. Under `start-app.bat`, close it and run again. |
| `.env` cookies | Nothing — re-read on the next query. |
| `.env` base URL / allowlist / max rows | Restart (they're read once at startup). |

If a `src/` change doesn't take effect, look at the **tsc watch** window: a type error
leaves the last good build running (`noEmitOnError`), so the server stays up serving the
previous code rather than crashing on broken output.

⚠ A restart kills any AI run in progress and clears staged work tickets, so avoid saving
a `src/` file mid-triage or mid-work-run. Recorded fixes are on disk and unaffected.

**The MCP server needs no registration** — `.mcp.json` at the repo root registers
`creatio-readonly` for any Claude Code session started in this directory. It requires
`npm run build` to have run (it launches `dist/index.js`) and a Claude Code restart to
pick up. Confirm with `claude mcp list`. See [MCP server](#mcp-server) for details.

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
- **Districts tab** — cases grouped by SIS district code. See [Districts](#districts--cases-by-sis-district) below.
- **Attachments** — screenshots embedded in descriptions and feed posts render **inline** (click to enlarge); email attachments appear as thumbnails. Images are streamed through a read-only `/api/file` proxy restricted to file entities + GUID ids.
- **Settings tab** — base URL, cookies, allowlist, row cap, plus **Test connection**.

The server binds to `127.0.0.1` only. It writes your local `.env`, the `.cache/` indexes, the `.audit/` log — and, only through the approval-gated 🔧 flow above, uncommitted edits in your `custom-reports` working tree.

### Districts — cases by SIS district

The district key is **`Account.NltDistrictCode`** on the case's Account. Its
values are the same codes as the `custom-reports` district folders (`HCA-CO`,
`SMA-NC`, `MILWAUKEE-DIO`), so a ticket and its ColdFusion templates line up.

Click **Build index** the first time. It pages case headers from the window start
(2 years, `HISTORY_SINCE` in `src/districtIndex.ts`) to today — a few minutes,
newest-first, and it **saves as it goes**: the list is usable while the backfill
is still running, and stopping or an expired cookie costs only the remaining
pages. Afterwards **Refresh** is incremental (seconds).

Then pick a district to read its ticket history — filter by status, search the
subjects, and expand any row to pull that case's description and timeline live.

Two honesty notes built into the UI:

- Only ~40% of cases carry a district code. The rest are mostly higher-ed
  accounts (universities, colleges) that genuinely have none; they land in a
  pinned **"No district code"** bucket rather than being dropped.
- For those, the ticket text can be scanned for a code — but a scanned code is
  only accepted if it already exists in the account registry, and it is badged
  **"code from subject/description"** so it is never mistaken for the
  authoritative field.

### AI analysis

With the **Claude CLI** installed and logged in, the results view shows an **"Analyze with AI"** bar — Summarize & prioritize, Common themes, Next actions, or a free-text question, streamed live and rendered as Markdown (copy / download as `.md`). Tick row checkboxes to analyze a subset; each row also has a "✨ analyze this one" button.

- Enable: `npm i -g @anthropic-ai/claude-code`, then run `claude` once to sign in. Uses **your Claude subscription — no API key**.
- Runs `claude -p` locally, **isolated** (no tools, no MCP, empty temp cwd); only the selected cases' **text** is sent — never your cookies. Set `CREATIO_APP_MODEL=sonnet` (or `haiku`) for cheaper/faster runs.

### Work on a case (🔧, gated repo edits)

Each result row also has a **🔧 "work on this case"** button (shown when the Claude
CLI *and* the `custom-reports` tree are both present). It runs a three-stage
pipeline built so that **no agent ever holds both raw case text and edit
tools**, and so that **you approve a specific plan rather than a blank cheque**:

1. **Triage (Stage A)** — the isolated, tool-less agent reads the raw case and
   proposes candidate files; every path is re-validated against the repo index
   (`src/triage.ts`). You see the resulting brief, the district folders that
   would be editable, and the README/CLAUDE.md docs the worker will read first.
2. **Plan (read-only)** — a second pass opens those files with **Read/Grep/Glob
   and nothing else** (Edit/Write/Bash are denied, not asked) and reports what
   it intends to change: a goal, a numbered list of files with the concrete
   edit for each, what it deliberately won't touch, and its open questions.
   Nothing has been modified at this point. Type a correction in the
   instruction box and click **↻ Re-plan** as many times as you like — a step
   aiming outside the approved folders is flagged in red rather than hidden.
3. **Approve** — nothing edits until you click **"Let Claude edit these folders"**.
   The click is recorded in the audit log as the human approval, and the plan
   on screen is handed to the worker as its direction.
4. **Worker (Stage B)** — the edit-capable agent runs inside `custom-reports` with
   Read/Grep/Glob plus Edit/Write **allowed only inside the implicated district
   folders** (`ReportCardRoot` shared includes stay read-only). It has no Bash,
   no web, no git — committing is structurally impossible. It reads the repo's
   README.md/CLAUDE.md files before touching code, and follows the approved
   plan, flagging any deviation under **Open questions** in its report.
5. **Review** — the panel streams the agent's tool calls and final report, then
   shows the exact uncommitted `git diff` per file (files that were already
   dirty before the run are listed separately). You review, adjust, and make
   the commit yourself.

Every step lands in `.audit/*.ndjson`: run start/end, each tool call, rejected
paths, the approval click, and the final patch summary.

---

## `/work-case` — the terminal path

The 🔧 flow above lives in the web app and needs clicks. `/work-case` is the same
job driven from a Claude Code session, for when you'd rather hand over a case
number and read a diff.

```
/work-case SR00061864
```

It reads the case from Creatio, classifies it, locates the file(s) in
`custom-reports`, makes the minimal fix, runs the static checker, and reports —
then stops at an **uncommitted working-tree diff**. It never commits, never
pushes, and never writes to Creatio.

The guardrails are configuration, not good intentions. `.claude/settings.json`
scopes `Edit`/`Write` to the eight district-bearing subrepos, **denies** writes to
`ReportCardRoot/` (one edit there changes every district at once), and denies
`git commit`/`push`/`checkout`/`reset`. A `PreToolUse` hook injects
`CASE-QUERY-REFERENCE.md` on the first Creatio call so the OData gotchas are
loaded before the first query, not after the first HTTP 500.

The design goal is that it stops **only** at the skill's stop-list — a shared
include, new-template work, honor roll, an A–C custom report, a genuine
file-selection tie, or something it cannot see. Every other stop is treated as a
missing rule, and the answer gets written into
`.claude/skills/work-case/references/learned-rules.md`, which Step 3 reads first
on the next run. That is the part that makes the interruption rate fall instead of
plateau.

### `scripts/check-cfml.mjs`

There is no build, no test suite and no CI gate in `custom-reports` — a CFML
syntax error ships straight to the NAS. This is the cheap net:

```bash
node scripts/check-cfml.mjs                       # every changed file, all subrepos
node scripts/check-cfml.mjs --dir ReportCardAO/EH-JAM
node scripts/check-cfml.mjs --all-lines --json
```

Checks broken `.cfm`/`.htm` pairing, unresolvable `<cfinclude>` targets,
`dbtype="ODBC"`, unbalanced block tags, SQL interpolation without
`<cfqueryparam>`, and `url.*`/`form.*` used without `<cfparam>`.

**Scoping is the whole trick.** These repos carry a decade of legacy — almost
every district folder has `dbtype="ODBC"` and bare `#StudentID#` interpolation. A
checker that reported all of it would fail on every file anyone touched and be
switched off within a day, so by default line-level findings are reported **only
for lines the current diff adds**: "did my edit introduce this?", not "does this
file have debt?". File-level findings always report. `--all-lines` audits
everything.

Three real-world calibrations are baked in, each of which was a false-positive
source before it was fixed:

- Pairing is checked only in `ReportCardAO`, `ReportCardPZ`, `ProgressReport` and
  `Transcripts`, where the convention is documented. `ReportsCustomSZ` alone has
  441 unpaired `.cfm` against 6 paired — single-file is the norm there.
- Include resolution honours the **flattened NAS layout**: all report-card repos
  deploy into one folder, and dispatcher templates stored in a district folder
  deploy to the subrepo root. A target that resolves only that way is a warning,
  not an error. Only a basename that exists nowhere in the subrepo is an error.
- Tag balance is counted both raw and comment-stripped, and errors only when both
  disagree. Legacy files have commented-out blocks that straddle tags
  (`<!---<cfif …>` … `</cfif>--->`), so stripping comments can invent an imbalance
  in a file that is genuinely fine.

---

## MCP server

| Tool | Description |
|---|---|
| `creatio_list_allowed_entities` | Show base URL, allowlist, and row cap |
| `creatio_query_records` | OData query (`$filter`, `$select`, `$orderby`, `$top`, `$expand`) |
| `creatio_get_record` | Fetch one record by GUID |
| `creatio_list_districts` | SIS district codes with case counts; search by code or school name |
| `creatio_district_history` | One district's ticket history, newest first, with a status tally |
| `creatio_case_district` | Which district a case belongs to, and where that code came from |

The three district tools read the local `.cache/district-cases.json` index and
never build it themselves — a first build pages through ~180k case headers, which
is not something a tool call should do unprompted. If the index is missing they
say so and point at the Districts tab.

Registration is committed as `.mcp.json` at the repo root, so any Claude Code
session started in this directory picks the server up — no per-machine
`claude mcp add`. It needs `npm run build` to have run (it launches `dist/index.js`)
and takes auth from `.env`, which `resolveCookieEnv()` re-reads on every call, so a
cookie refresh needs no restart.

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

**Agentic maturity:** the in-app Analyze feature is **Stage 1 — Guided Task**; the triage pipeline is **Stage 2 — Multi-Step** (multi-tool, read-only). The 🔧 **Work on a case** flow is the first **Stage 3 — Autonomous Workflow** step: it acts (repo edits), but gated behind an explicit approval, scoped by the permission system, fully audited, and always leaving the final commit to a human. Creatio write-back remains the next Stage 3 milestone.

---

## Scripts

| Script | Does |
|---|---|
| `npm run build` | Compile TypeScript to `dist/` |
| `npm run app` | Build + start the web app |
| `npm run watch` | Recompile on every `src/` save (the compiler half of watch mode) |
| `npm run app:watch` | Run the server, restarting itself whenever `dist/` changes |
| `npm start` | Start the MCP server (stdio) |
| `npm run test-auth` | Verify credentials without starting anything |

## License

_Add a license (e.g. MIT) before publishing._
