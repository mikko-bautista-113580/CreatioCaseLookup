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
- 📂 **Workspace analysis** — point the app at up to **3 folders** you're working in and get a **read-only** code analysis of them together, capped at 10 top-level files so it stays fast. Reports are stored under `.analysis/` and reused by the bundled skills.
- 🎯 **Case-scoped analysis** — with a case bound, **Analyze for SRxxxxxxxx** reads only the files related to that case (searched in subfolders too, ranked by the case's keywords and school code), so a fix starts from the right handful of files instead of the whole folder.
- 🧩 **Case → code → fix** — the Workspace tab runs in three phases: pick the **case**, point at the **folders**, then **Plan the fix**. You get every change as a before/after diff; nothing is written until you press Apply, and applied edits are left **uncommitted** for review.
- ⚙️ **In-app settings** — paste/refresh SSO cookies, base URL, allowlist, row cap; no VS Code required.
- 📡 **Live progress** — the search streams per-case progress with a percentage bar.

## Repository layout

```
creatio_case_lookup/
  creatio_client.py    Shared read-only OData client (auth, cookies, GET, file download)
  case_lookup.py       Case-lookup query recipes (search, description, timeline, attachments)
  claude_run.py        Generic Claude CLI runner (spawn, NDJSON stream, tool clamping)
  analyze.py           Case AI analysis prompts (isolated run: no tools, no MCP)
  workspace.py         Workspace path validation, file enumeration, .analysis/ store
  case_brief.py        Bound case + stored case brief (.analysis/cases/)
  case_keywords.py     Case text -> sanitized, weighted search terms
  case_files.py        Recursive search + ranking of the files related to a case
  case_scope.py        Keywords + related files for one case
  fix_plan.py          Fix planning (read-only) + reviewed apply (plain Python)
  analyze_workspace.py Read-only workspace analysis (Read/Glob/Grep only)
  workspace_cli.py     CLI over the workspace store, used by the skills
  server.py            Local web app (FastAPI): static hosting + JSON/SSE API
  mcp_server.py        MCP server (thin surface over creatio_client)
  test_auth.py         Standalone credential check
tests/               pytest suite
public/              Web app UI (vanilla HTML/CSS/JS, zero runtime deps)
.claude/skills/      creatio-case-lookup, workspace-analysis, creatio-case-fix
.analysis/           Stored workspace analyses + case briefs (git-ignored local state)
start-app.bat        One-click launcher for the web app (Windows)
.env.example         Copy to .env and fill in
```

---

## Quick start

**Prerequisites:**

- **Python 3.12+**.
- **Claude CLI** (optional, for the AI features): `npm i -g @anthropic-ai/claude-code`, then run `claude` once to sign in.

```bash
git clone <your-repo-url> creatio-case-toolkit
cd creatio-case-toolkit
python -m venv .venv
.venv\Scripts\python -m pip install -e ".[login,dev]"   # [login] = browser login, [dev] = pytest
.venv\Scripts\python -m playwright install chromium    # only if you have neither Chrome nor Edge
copy .env.example .env    # then edit .env (see Configuration)
.venv\Scripts\python -m creatio_case_lookup.test_auth   # confirm credentials work (✔ Success)
```

**Run the web app:**

```bash
.venv\Scripts\python -m creatio_case_lookup.server     # starts the server, opens http://127.0.0.1:3000
```

On Windows you can just double-click **`start-app.bat`**. It finds Python 3.12+, creates the `.venv`, installs packages (and reinstalls them whenever `pyproject.toml` changes), creates `.env` from `.env.example` if there isn't one, and prints a setup check before starting. The same checklist is the app's first tab, **Setup**, with a fix for each item. Run the check on its own with `.venv\Scripts\python -m creatio_case_lookup.preflight`.

**The MCP server is already registered** — this repo ships a project-scoped [`.mcp.json`](.mcp.json), so Claude Code picks it up automatically when opened on this folder (after the `.venv` exists). Approve the server when prompted.

To register it somewhere else instead:

```bash
claude mcp add creatio-readonly -- <repo>\.venv\Scripts\python -m creatio_case_lookup.mcp_server
```

---

## Configuration

All settings live in `.env` — the MCP server loads it from the project root itself (next to the `creatio_case_lookup` package), so its registration needs no `env` block and both the server and the web app read the same file. **Never commit `.env`** — it holds live credentials/cookies (it's git-ignored by default).

| Variable | Purpose |
|---|---|
| `CREATIO_BASE_URL` | Your Creatio URL, e.g. `https://<your-tenant>.creatio.com` |
| `CREATIO_LOGIN` / `CREATIO_PASSWORD` | Forms-auth service account (Mode 1) |
| `CREATIO_ASPXAUTH` / `CREATIO_BPMCSRF` / `CREATIO_BPMLOADER` | SSO session cookies (Mode 2) |
| `CREATIO_ALLOWED_ENTITIES` | Comma-separated entity allowlist (e.g. `Case,Activity,Contact,Account,SocialMessage,CaseFile`). `CaseFile` is metadata-only and enables the attachment list in the Workspace tab |
| `CREATIO_MAX_TOP` | Max rows per query (default 50) |
| `CREATIO_APP_PORT` | Web app port (default 3000) |
| `CREATIO_APP_NO_OPEN` | Set `1` to stop the app auto-opening the browser |
| `CREATIO_APP_MODEL` | Fallback model, used only when `.claude/settings.json` sets none. The model, effort and output style for every AI run are set in **Settings → Claude settings** (default `claude-opus-5-5`, medium effort, Concise) |
| `CREATIO_WORKSPACE_PATH` / `_2` / `_3` | The 1-3 folders the Workspace tab analyzes together (normally set from the UI) |
| `CREATIO_WORKSPACE_FILE_CAP` | Total top-level file count (all folders) above which the app asks before analyzing (default 10) |
| `CREATIO_WORKSPACE_TIMEOUT_MS` | Hard timeout for one workspace analysis (default 300000) |
| `CREATIO_WORKSPACE_CASE` | The case bound in the Workspace tab's phase 1 (normally set from the UI) |
| `CREATIO_FIX_TIMEOUT_MS` | Hard timeout for one fix-planning run (default 600000) |

### Authentication

The client auto-selects a mode based on which vars are set.

- **Mode 1 — Forms auth (recommended):** a **local**, least-privilege, read-only Creatio service account (`CREATIO_LOGIN` + `CREATIO_PASSWORD`). Re-authenticates automatically on expiry.
- **Mode 2 — Cookie auth (SSO tenants):** paste a browser session's cookies (`.ASPXAUTH`, `BPMCSRF`, `BPMLOADER`) from **DevTools → Application → Cookies**. Cookies expire in hours; refresh them in `.env` or the app's **Settings** tab and the next query picks them up — **no restart needed**.

Verify either mode with `.venv\Scripts\python -m creatio_case_lookup.test_auth`.

---

## Web app

- **Lookup tab** — choose *who* (assignee / case number / account / all recent), *which statuses*, and *how much detail* (summary, full description, timeline, latest update, extra fields), then **Search**. Results stream in with a progress bar.
- **Attachments** — screenshots embedded in descriptions and feed posts render **inline** (click to enlarge); email attachments appear as thumbnails. Images are streamed through a read-only `/api/file` proxy restricted to file entities + GUID ids.
- **Workspace tab** — three phases: **1** pick the case you're working on, **2** point at the folder(s) and run a read-only analysis, **3** plan a fix, review every edit as a diff, and apply it (see below).
- **Settings tab** — base URL, cookies, allowlist, row cap, plus **Test connection**.

The server binds to `127.0.0.1` only. Inside this repo it writes your local `.env` (Settings, Workspace path, bound case) and `.analysis/` (workspace reports, case briefs, fix plans and pre-edit backups). The only time it writes **outside** this repo is when you press **Apply** on a fix plan you have reviewed — never during an analysis, and never without that approval.

### AI analysis

With the **Claude CLI** installed and logged in, the results view shows an **"Analyze with AI"** bar — Summarize & prioritize, Common themes, Next actions, or a free-text question, streamed live and rendered as Markdown (copy / download as `.md`). Tick row checkboxes to analyze a subset; each row also has a "✨ analyze this one" button.

- Enable: `npm i -g @anthropic-ai/claude-code`, then run `claude` once to sign in. Uses **your Claude subscription — no API key**.
- Runs `claude -p` locally, **isolated** (no tools, no MCP, empty temp cwd); only the selected cases' **text** is sent — never your cookies. Uses the model, effort and output style from **Settings → Claude settings** (saved to `.claude/settings.json`; default **Claude Opus 5.5**, `claude-opus-5-5`, medium effort, Concise). Pick Sonnet 5 or Haiku 4.5 there for cheaper/faster runs.

### Workspace analysis

The **Workspace tab** takes the absolute path of the folder you're working in — plus up to two more via **+ Add another folder** — saves them to `.env` (effective immediately, no restart), and runs a **read-only** analysis.

- **Several folders, one report.** The folders are analyzed together as a single workspace, which is what you want when a fix spans a report template and the shared includes it pulls in. The first folder is the analyzer's working directory; the others are granted explicitly with `--add-dir`. Adding or removing a folder makes it a different workspace with its own stored report.

- **Read-only by construction.** The child process is spawned with `--tools Read,Glob,Grep`, which removes `Edit`, `Write` and `Bash` from its tool *schema* — not merely from its permissions. Deny rules additionally block `.env`, `*.pem`, `*.key` and SSH keys, so an analysis of this repo cannot read your Creatio cookies. Every tool call is recorded in the report's sidecar, so you can see exactly which files were touched.
- **Capped at 10 top-level files in total** so a run stays fast. Only files directly in each folder count — no recursion — and the cap applies to the sum across folders. Above the cap the app **does not start**: it tells you the run will take longer and offers "analyze all N anyway" or a single-file pick. The API enforces the same rule, so a stray request can't kick off a huge run either.
- **Excluded automatically:** secret-bearing files (`.env`, keys, certs — counted but never listed), files over 512 KB, non-text files, and the usual build/dependency directories.
- **Stored** as `.analysis/<slug>/analysis.md` plus a JSON sidecar (files analyzed, tool calls, model, cost, `truncated` flag), indexed in `.analysis/index.json`. The folder is **git-ignored local state** — safe to delete.

### Case-scoped analysis

With a case bound in phase 1, the button reads **Analyze for SRxxxxxxxx** and analyzes only what that case touches — which is usually a handful of files in a folder of thousands.

- **Finding the related files — fast and model-free.** The app turns the case's subject, description and recent emails into a short list of keywords (school codes like `EP-JAM` and file names like `EP-JAM-RC.cfm` weigh the most), then searches the folders **recursively**. A folder named after the school code is walked first; files are ranked by path and content matches, with words that appear in almost every file (like "report") counting for little; one hop of `<cfinclude>` is followed; and anything scoring well below the best match is dropped. The result is capped at the file limit, so there is no over-cap prompt in this mode. On a reports root of 1,700+ school folders this picks the right school's files in a few seconds.
- **Preview first.** **Preview related files** shows the chosen files (with why each was picked) — without running Claude. **Analyze whole folder instead** keeps the classic analysis one click away.
- **What the analysis receives from the case.** Only the app-extracted keywords (lowercased, reduced to a safe alphabet, max 40 characters each) and the file list the app picked — never the client's wording. The fix plan, as before, does read the case text, with no write tools.
- **Stored** as `.analysis/<slug>/cases/<SR>.md` plus sidecar (selected files and reasons). It goes stale when a selected file changes or the case is re-fetched.

The skills use the same logic: `python -m creatio_case_lookup.workspace_cli scope <SR>` prints the keywords and related files.

> **Accepted limitation:** because the analysis child runs *in* your folder, that folder's own `CLAUDE.md` is loaded into its context and cannot be suppressed by any current flag. The folder is one you chose, and `--tools` bounds the worst case to "read files here and write a misleading report" — but if you analyze a directory you don't trust, read the report with that in mind.

### Case → code → fix

The Workspace tab is **case-first**, because that's how the work actually arrives: a client reports something, you work out which folder it lives in, then you fix it.

1. **Case** — search by number, owner, account or "all recent" (the same queries as the Lookup tab) and pick one. The app fetches its description, full conversation and **attachments** and stores them as a *brief* in `.analysis/cases/<SR>.json`; the case number goes in `.env` as `CREATIO_WORKSPACE_CASE`. Both survive a browser reload **and** a fresh Claude Code session. **Refresh** re-pulls the case when it has moved on; **Unbind** clears it.

   The description is rebuilt into a readable list — support cases are usually numbered asks, and Creatio's HTML arrives flattened — with each ask's continuation lines and indented sub-points kept with it.

   Attachments show as thumbnails (click to enlarge) or open-in-tab links, streamed through the read-only `/api/file` proxy. An image can be **saved straight into a workspace folder** (↓ save to folder) when the client wants it used in the template — e.g. a school logo. The filename is editable, since the template usually references a specific name.

   > That save is the only write outside this repo besides an approved fix apply, so it is narrow: **images only** (no `.svg` — it can carry script), the bytes must actually *be* that image type (leading bytes are checked, so client-supplied content named `logo.png` is rejected and a JPEG can't be saved as `.png`), the target must be a configured folder, the client-supplied name is reduced to a bare filename, 10 MB cap, and replacing an existing file needs a second confirm and copies the original to `.analysis/assets/` first. Listing them needs `CaseFile` in `CREATIO_ALLOWED_ENTITIES`; without it the brief records a caveat instead of failing. **Their contents are not read when planning a fix** — the planner is given the filenames only, so a logo's exact colours still have to come from the case text.
2. **Working directory** — the folders and their read-only analysis, as described above: case-scoped when a case is bound, whole-folder otherwise.
3. **Fix** — press **Plan the fix**. A read-only pass reads the case, the stored analysis (the case-scoped one when it exists) and the relevant files, then shows you each proposed change as a **before/after diff** with its reasoning, risks and what it does *not* fix. Nothing has touched disk at this point. Press **Apply** and the edits are written and left **uncommitted and unstaged** so you review the diff yourself. Originals are backed up first, so it's reversible even outside git.

   The review also breaks the case into **what the client actually asked for** — using the case's own numbering where it has any — marks each ask *addressed*, *partly addressed* or *not addressed*, and tags every edit with the ask it serves. So you can check the plan against the client's email rather than inferring intent from a diff, and see at a glance which parts were left alone.

   An applied plan stays on screen as a read-only record of what it changed, and can't be applied twice — press **Plan the fix** again for a fresh one.

   > Those *addressed* labels are the model's own claim, not something the app can verify. On the default **Opus** model they hold up — an ask needing a capability the code doesn't have comes back *not addressed*. Weaker/cheaper models over-claim: Haiku marked "add a PDF export button" as addressed and proposed a button that wouldn't do it. If you set `CREATIO_APP_MODEL` to something cheaper, treat the coverage labels as a prompt to check, not an answer.

The phases are **softly ordered** — phase 2 works with no case bound, so you can still just analyze a folder. Phase 3 stays disabled, naming what's missing, until a case, folders and a stored analysis all exist.

> **How the fix button stays safe.** Case descriptions and emails are prose written by clients and third parties, so the model that reads them is given **no write tools at all** — `Read`, `Glob` and `Grep` are the only things in its schema, with no `Bash`, no `WebFetch` and no `WebSearch`. It can only *propose* a structured list of edits. The **app** applies them, and before writing anything it re-checks that each file is one it is allowed to edit — a top-level source file of a configured folder, or one of the files the case-scoped analysis selected in a subfolder — and that the "before" text still matches **exactly once**. So the worst a malicious instruction buried in a case could achieve is a bad patch — one you see as a diff, that can't reach a file outside your workspace, that can't execute or phone home, and whose original is backed up.
>
> Apply is **all-or-nothing**: if any file changed between planning and approval, nothing is written and you re-plan. Plans, and the originals they replaced, are kept under `.analysis/fixes/<plan id>/`.
>
> **What the folder setting does and does not bound.** It bounds **edits** exactly — only a top-level source file of a configured folder, or a file the case-scoped analysis selected inside one, can be written. It does **not** bound **reads**: `Glob` and `Grep` take absolute paths, so the planning pass can and does read shared code elsewhere on disk (tracing a report template back into `ReportCardRoot`, say) — everything except the denied `.env`, key and certificate patterns. That is usually what you want, since a fix often depends on an include outside the folder. The consequence to know: a plan may propose an edit to a file it could read but cannot write, and that edit shows as **can't apply** with a note to re-run the case analysis so it's selected, or add the folder in phase 2, and re-plan.

The in-app button needs no setup. The `creatio-case-fix` skill remains available for when you want to work a case through conversationally — pushing back on the diagnosis, asking for alternatives — rather than accepting or rejecting a diff. Run `/creatio-case-fix` in Claude Code from this repo; because the Creatio tools are project-scoped here while your files live elsewhere, it may ask you to `/add-dir <workspace path>` first, and it checks that *before* spending effort on a recommendation.

### Bundled skills

Three skills in `.claude/skills/` drive these workflows from a Claude Code conversation:

| Skill | What it does |
|---|---|
| `creatio-case-lookup` | Interactive case lookup — who, which statuses, how much detail |
| `workspace-analysis` | Analyzes the working folder(s) and stores the report (same 10-file total cap and over-cap prompt as the tab); with a case bound, points you at the case scope instead |
| `creatio-case-fix` | Reads a case's description + conversation, loads the case-scoped analysis (or computes the case scope: related files), recommends a fix, and — **only after you approve** — applies the edits and leaves them **uncommitted** for review |

The skills and the app share one implementation of the cap rule and the artifact schema via `python -m creatio_case_lookup.workspace_cli`, so reports from either side are interchangeable.

Because the Creatio MCP server is project-scoped in `.mcp.json`, `creatio-case-fix` needs Claude Code running in *this* repo, while the files it edits usually live elsewhere. If it can't read your workspace, run `/add-dir <workspace path>` (or start with `--add-dir`) and retry.

---

## MCP server

| Tool | Description |
|---|---|
| `creatio_list_allowed_entities` | Show base URL, allowlist, and row cap |
| `creatio_query_records` | OData query (`$filter`, `$select`, `$orderby`, `$top`, `$expand`) |
| `creatio_get_record` | Fetch one record by GUID |

Registered via the project-scoped [`.mcp.json`](.mcp.json) in this repo — config comes from `.env`, so no `env` block is needed:

```json
{
  "mcpServers": {
    "creatio-readonly": {
      "type": "stdio",
      "command": ".venv/Scripts/python",
      "args": ["-m", "creatio_case_lookup.mcp_server"],
      "env": {}
    }
  }
}
```

Requires the project's `.venv` (see Quick start). Anything set in an `env` block would take precedence over `.env`, since `.env` loading never overrides vars already in the process environment.

> Foreign keys like `OwnerId`/`AccountId`/`StatusId` are **not** filterable — filter through navigation paths (`Owner/Id`, `Account/Id`, `Status/Name`). See `CASE-QUERY-REFERENCE.md` for the full query recipes and gotchas.

---

## Security & data handling

- **Read-only:** the client issues HTTP `GET` only; there is no write path to Creatio anywhere in the codebase.
- **Local & single-user:** the web app binds to `127.0.0.1`, with no app-level auth by design.
- **Secrets stay local:** cookies/credentials live in `.env` (git-ignored) and are masked in the UI; AI analysis receives only case **text**, never cookies.
- **Bounded reach:** entity allowlist + `$top` clamp; the file proxy is limited to a fixed set of file entities and GUID ids.
- **Workspace analysis is read-only too:** the analysis child gets `--tools Read,Glob,Grep`, which removes `Edit`/`Write`/`Bash` from its tool *schema*, plus deny rules for `.env`, keys and certificates. `--safe-mode` and `--setting-sources user` stop the analyzed folder's own `.claude/settings.json` hooks from running. Every tool call is recorded in the report sidecar.
- **Applying fixes is gated on you:** both routes — the Workspace tab's **Plan the fix** and the `creatio-case-fix` skill — propose a change, wait for explicit approval, and leave the edits **uncommitted**. Nothing is ever committed, staged or pushed for you.
- **The model that reads case text never holds a write tool:** planning runs with `--tools Read,Glob,Grep` and no `Bash`/`WebFetch`/`WebSearch`, and returns a structured edit list. The app applies it, re-verifying that every target is a top-level source file of a configured folder (or a file the case-scoped analysis selected inside one) and that each "before" string still matches exactly once. Apply is all-or-nothing, and originals are backed up under `.analysis/fixes/`.

---

## Roadmap

- **✍️ Write-back (Stage 3):** draft case replies / status updates with AI, then post them to Creatio **on explicit human approval**, and verify the write succeeded. This is the planned next step and will be gated, audited, and opt-in — the read-only default stays.
- OAuth 2.0 client-credentials auth for unattended SSO use.
- Pagination past the 50-row cap in the UI; attachment-count badges.
- Optional `ActivityFile` inline email images.

**Agentic maturity:** today the toolkit is **Stage 2 — Multi-Step** (multi-step, multi-tool, read-only "generate but don't run"); the in-app Analyze feature is **Stage 1 — Guided Task**. Write-back is what moves it into **Stage 3 — Autonomous Workflow**.

---

## Commands

Run each with `.venv\Scripts\python -m <module>`:

| Module | Does |
|---|---|
| `creatio_case_lookup.server` | Start the web app |
| `creatio_case_lookup.mcp_server` | Start the MCP server (stdio) |
| `creatio_case_lookup.test_auth` | Verify credentials without starting anything |
| `creatio_case_lookup.workspace_cli` | Workspace store CLI (`path` / `scan` / `load` / `save` / `case` / `attachment` / `scope`) — used by the skills |
| `pytest` | Run the test suite (`.venv\Scripts\python -m pytest`) — no network, Creatio or Claude needed |

## Development

- Code lives in `creatio_case_lookup/`; tests in `tests/` (pytest, one file per module). Everything network- or subprocess-bound is `async`; pure logic is plain functions.
- The browser UI in `public/` is plain HTML/JS with no build step. Its contract with `server.py` — routes, JSON keys (camelCase), SSE event names — must change on both sides together.
- On-disk formats under `.analysis/` (reports, sidecars, briefs, plans) keep camelCase keys so existing stored data stays readable.

## License

_Add a license (e.g. MIT) before publishing._
