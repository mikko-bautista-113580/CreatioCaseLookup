# Creatio Case Query Reference

Practical notes for pulling **specific information about a Case** (and its
Timeline) from `https://nelnet.creatio.com` via the read-only OData 4 endpoint.
Built from real queries — includes the gotchas that aren't obvious.

---

## 1. Auth (how requests are made)

- **Mode:** cookie auth (SSO tenant — no local password).
- **Credentials live in** this repo's own `.env` (`c:\neldevsrc\tools\CreatioCaseLookup\.env`):
  `CREATIO_ASPXAUTH`, `CREATIO_BPMCSRF`, `CREATIO_BPMLOADER`, `CREATIO_BASE_URL`.
- ⚠️ **Cookies expire in hours** and cannot auto-refresh. When reads start
  returning `401/403`, re-grab from browser DevTools → Application → Cookies
  (`.ASPXAUTH`, `BPMCSRF`, `BPMLOADER`) and update `.env`.
- Verify auth quickly: `npm run test-auth` (exit 0 = good).

### Required headers on every OData GET
```
Accept:  application/json
Cookie:  .ASPXAUTH=<val>; BPMCSRF=<val>; BPMLOADER=<val>
BPMCSRF: <same BPMCSRF value, echoed as a header>
```

### OData base URL
```
${CREATIO_BASE_URL}/0/odata/<Entity>?<query>
```
Full data model: browse `${CREATIO_BASE_URL}/0/odata/$metadata`.

### ⚠️ Always pass `$select` — never read all columns

An all-columns read returns **HTTP 500**, not data:

```
GET /0/odata/Case?$top=1            -> 500  "The 'ObjectContent`1' type failed to serialize
                                             the response body ... The EDM instance of type
                                             '[Terrasoft.Configuration.OData.Case]' is missing
                                             the property 'NltAdditionalInformation'"
GET /0/odata/Case?$select=Id&$top=1 -> 200  ✅
```

This tenant's published EDM model advertises a custom column the runtime record
doesn't actually have. `Case` and `Contact` both fail this way; an all-columns
`Account` read is slow enough to time out. **Name the columns you want.**

The same failure appears inside `$expand` — see `CASE_EXPAND` in
[src/districtIndex.ts](src/districtIndex.ts) for the verified-safe expand list
(do **not** add `ParentId` or `NltRegionId` to the Account sub-select).

---

## 2. The two ways to query

### A. MCP tools (preferred, once loaded)
After `claude mcp` registration + **Claude Code restart**, these appear:
- `creatio_list_allowed_entities`
- `creatio_query_records` — args: `entity`, `select[]`, `filter`, `orderby`, `top`, `expand`
- `creatio_get_record` — `entity` + GUID

**Allowlist** (`CREATIO_ALLOWED_ENTITIES`, set in `.env` AND the MCP registration):
`Case, Activity, Contact, Account, SocialMessage`
Row cap `CREATIO_MAX_TOP=50`.

> **SSO cookies** are read live from the `.env` **file** on disk (the file wins
> over the MCP registration), and the server re-reads it on the next query — so
> refreshing `.ASPXAUTH` / `BPMCSRF` / `BPMLOADER` in `.env` takes effect with
> **no restart and no re-registration**.
>
> Other config (allowlist, base URL, row cap) still comes from the MCP
> **registration** (`~/.claude.json`, local scope). To change the **allowlist**:
> edit `.env`, then `claude mcp remove creatio-readonly -s local` and re-add with
> the new `--env CREATIO_ALLOWED_ENTITIES=...`. (See README "Register in Claude
> Code".)

### B. One-off Node script (works in the current session, bypasses MCP allowlist)
Use when the MCP tools aren't loaded yet, or to touch an entity not in the
allowlist. Reusable template — write to scratchpad, run with env sourced:

```bash
set -a && . ./.env && set +a && node <script>
```

```js
// creatio-query.mjs  — generic read-only OData GET
const B=process.env.CREATIO_BASE_URL.replace(/\/+$/,'');
const aspx=process.env.CREATIO_ASPXAUTH.replace(/^\.?ASPXAUTH=/i,'');
const csrf=process.env.CREATIO_BPMCSRF.replace(/^BPMCSRF=/i,'');
const loader=(process.env.CREATIO_BPMLOADER||'').replace(/^BPMLOADER=/i,'');
const cookie=[`.ASPXAUTH=${aspx}`,`BPMCSRF=${csrf}`,loader&&`BPMLOADER=${loader}`].filter(Boolean).join('; ');
const H={Accept:'application/json',Cookie:cookie,BPMCSRF:csrf};
const get=async p=>{const r=await fetch(`${B}/0/odata/${p}`,{headers:H});
  if(!r.ok){console.error('HTTP',r.status,(await r.text()).slice(0,300));return[];}
  return (await r.json()).value||[];};
```

---

## 3. Getting a Case by its number (SRxxxxxxxx)

```
Case?$filter=Number eq 'SR00026236'&$top=1
```
Returns the full record. Key readable fields:
`Id, Number, Subject, Symptoms (HTML), CreatedOn, ModifiedOn, RegisteredOn,
ResponseDate, SolutionDate, SolutionOverdue, NltHoursWorked`.

Get by GUID directly:
```
Case(f3ed4f55-894b-42bc-b5a1-f10b9d0bc03f)
```

---

## 4. The **Timeline tab** = TWO entities merged

The Creatio Timeline/Discussion tab is a **composite view**. To reproduce it,
query both and merge by `CreatedOn`:

### 4a. Feed posts ("X posted in case") → `SocialMessage`
Linked to the case by `EntityId`:
```
SocialMessage?$filter=EntityId eq <CaseGuid>&$orderby=CreatedOn asc&$top=50
```
Body is in `Message` (HTML, may contain `@mention` anchor tags).

### 4b. Emails (incl. drafts + system "assigned to you") → `Activity`
There is **no queryable `Activity.CaseId`** (`$filter=CaseId eq ...` → **HTTP 500**).
Link emails to a case by matching the case number in the **Title**
(Creatio auto-stamps `Case #SRxxxxxxxx` into every reply subject):
```
Activity?$filter=contains(Title,'SR00026236')&$top=50
```
Useful fields: `Title, CreatedOn, Sender, Recepient` (note spelling),
`CopyRecepient, BlindCopyRecepient, Body (HTML), SendDate`.

---

## 5. Gotchas learned the hard way

| Gotcha | Detail / workaround |
|--------|--------------------|
| **`Activity.CaseId` is not queryable** | `$filter=CaseId eq …` returns HTTP 500. Link via `contains(Title,'SR…')` instead. |
| **`$select` can silently 0 out results** | Including a non-existent field name makes the whole query return empty (and a helper that treats non-2xx as `[]` hides it). Query without `$select` first, inspect `Object.keys(row)`, then add a verified `$select`. |
| **Author names DO NOT resolve** | `SocialMessage.CreatedById` / `Activity.AuthorId` are GUIDs. `SysAdminUnit.Name` comes back **undefined** over this OData access, and its `ContactId` path dead-ends. **Do not infer the author from @mentions in the message text — that is a guess and has been wrong.** The Creatio UI screenshot is the authoritative source for "who posted." Report author as *unresolved* unless confirmed visually. |
| **Email bodies are messy HTML** | Full of Outlook VML junk (`v\:* {behavior:url(#default#VML);}` etc.) and quoted-reply history. Strip `<style>` blocks + tags, and cut at `From:` / `On … wrote:` / `Caution: This Message is From an External Sender` to isolate the new content. |
| **Some emails have empty `Body`** | e.g. a client reply whose content lived only in quoted history/attachment — comes back blank. |
| **`$TMPDIR` not set in this shell** | Write scratch scripts to the session scratchpad path, not `$TMPDIR`. |
| **`ParentId` / `NltRegionId` break an Account `$expand`** | `$expand=Account($select=Name,ParentId)` returns HTTP 500 (*"failed to serialize the response body"*). Either field alone triggers it. Both read fine in a **direct** `Account` query, so account hierarchy needs its own request. |
| **`Case/$count` returns non-JSON** | Use `?$count=true&$top=1` and read `@odata.count` instead. |
| **The 50-row cap is ours, not Creatio's** | `CREATIO_MAX_TOP=50` is a local guardrail. Server-side, `$top=1000` returns 1000 rows in ~1.4 s and `$skip` works. `creatioClient.pageRecords()` exists for app-authored bulk reads at up to 1000/page; the MCP surface stays clamped at 50. |
| **`CaseStatus` *is* queryable, and there are 28 statuses** | Older notes in this repo claimed otherwise. `CaseStatus?$select=Id,Name&$top=100` returns all 28 in one request. `caseLookup.ts` still hardcodes 6 of them and its `statusFilter()` **silently drops** anything else — so an "open / active" filter built on that list quietly excludes `Reopened`, `Re-opened`, `New-Reopened`, `Response Received`, `Triage`, `Escalated`, `On Hold`, `Waiting (External)`, `Waiting on client` and others. |
| **Deep `$skip` gets slow** | For big sweeps, keyset-page on `CreatedOn` (`$orderby=CreatedOn desc` + a moving `CreatedOn lt/le <cursor>`) rather than walking `$skip` through 100k+ rows. Use `le` and dedup by `Id` so a group of cases sharing one timestamp can't straddle a page boundary and vanish. |
| **`$filter` has a 100-node expression limit** | An `Id eq A or Id eq B or …` chain of **20** fails with *"The node count limit of '100' has been exceeded"*; **15 is the measured ceiling**. Batch id lookups at ~12. The OData v4 `in (…)` operator would avoid this but **is not supported** on this tenant. |

### HTML-strip helper (feed + email bodies)
```js
const strip=h=>(h||'')
  .replace(/<style[\s\S]*?<\/style>/gi,'')
  .replace(/<a[^>]*data-mention-display-value="([^"]*)"[^>]*>.*?<\/a>/gs,'@$1') // keep mention text
  .replace(/<[^>]+>/g,' ')
  .replace(/&nbsp;/g,' ').replace(/&#39;|&rsquo;/g,"'").replace(/&amp;/g,'&')
  .replace(/&quot;|&ldquo;|&rdquo;/g,'"').replace(/&mdash;/g,'-')
  .replace(/v\\?:\*|o\\?:\*|w\\?:\*|\.shape|\{behavior:url\(#default#VML\);\}/g,'')
  .replace(/\s+/g,' ').trim();
const trimReply=t=>t.split(/From:\s|On .{5,40} wrote:|Caution: This Message is From an External Sender/)[0].trim();
```

---

## 6. Reference example — Case SR00026236

- **Id:** `f3ed4f55-894b-42bc-b5a1-f10b9d0bc03f`
- **Subject:** FIX: HCA-CAN Senior Report Card Template
- **Account:** Hope Christian Academy · **Contact:** Ashleigh Braun
- **Timeline:** 7 `SocialMessage` feed posts + 12 `Activity` emails (Feb–Jul 2026)
- **Ties to code:** ColdFusion templates `HCA-CAN_senior.cfm` /
  `HCA-CAN_1-6.cfm` in `c:\neldevsrc\ColdfusionReports\ReportCardAO\HT-CAN`.

---

## 7. Quick recipe: full merged timeline for a case

1. Resolve the Case → get its `Id`.
2. `SocialMessage?$filter=EntityId eq <Id>&$orderby=CreatedOn asc&$top=50` → feed.
3. `Activity?$filter=contains(Title,'<Number>')&$top=50` → emails.
4. Tag each with `kind` (FEED/EMAIL), merge, sort by `CreatedOn`.
5. `strip()` bodies; `trimReply()` emails.
6. Leave author = GUID / "unresolved" unless confirmed from the Creatio UI.

---

## 8. The SIS district code — grouping cases by district

**`Account.NltDistrictCode` is the SIS district ID.** Its values are the *same
codes* as the district folders under `custom-reports` (`HCA-CO`, `SMA-NC`,
`SGB-MO`, `MILWAUKEE-DIO`), which is what makes a case → ColdFusion-template
join possible.

Verified live:

| | |
|---|---|
| Accounts carrying a code | **9,768** |
| Distinct codes | **8,741** (65+ shared by more than one account — dioceses, multi-campus districts) |
| Cases total / with a code | **417,957** / **207,129** |
| Coverage on recent cases | ~40%. The rest are overwhelmingly **higher-ed** accounts (universities, colleges) that legitimately have no district code and carry a numeric `Account.Code` instead |

### It's on the Account, not the Case

`Case.NltSchoolCode` and `Case.NltMidNumber` **exist but are empty** — 0/50 on
recent cases. Don't use them. Reach the code through the Account.

```
# filter cases by district (navigation path — works)
Case?$filter=Account/NltDistrictCode eq 'SMA-NC'&$orderby=CreatedOn desc&$top=50

# startswith / contains also work on the nav path
Case?$filter=startswith(Account/NltDistrictCode,'HCA')
Case?$filter=contains(Account/NltDistrictCode,'-NC')

# read it alongside the case (this expand shape is verified safe)
Case?$select=Id,Number,Subject,CreatedOn,AccountId
    &$expand=Status($select=Name),Owner($select=Name),Account($select=Name,NltDistrictCode)

# enumerate the districts themselves
Account?$select=Id,Name,NltDistrictCode&$filter=NltDistrictCode ne null&$top=1000&$skip=0
```

⚠️ Do **not** add `ParentId` or `NltRegionId` to that Account `$select` inside an
`$expand` — HTTP 500 (see gotchas).

### Recovering a code when the account has none

Case Subjects embed their own district code often (`"SMA-NC - Custom GPA
Report"`). `districtIndex.ts` scans Subject, then optionally the `Symptoms`
description, but **only ever accepts a token that already exists in the account
registry** — so it can't invent a district. Every row records provenance
(`account` = authoritative, `subject` / `description` = inferred), and inferred
codes are badged as such in the UI. In practice the text-scan yield is low
(single digits per thousand): unattributed cases really are mostly higher-ed.

### Don't page this live — use the index

Grouping and history search run off a local index (`.cache/district-cases.json`,
built by the app's **Districts** tab). Case *descriptions and timelines are not
in it* — those are still fetched per case on demand. MCP tools over the index:
`creatio_list_districts`, `creatio_district_history`, `creatio_case_district`.

### Other Nelnet district-ish fields (checked, not used)

`Account.NltLEAID` (~6% filled — the federal Local Education Agency id),
`Account.NltLEAName` (empty), `Account.NltSchoolCode` (empty),
`Account.NltTMSSchoolCode` (~0.5%), `Account.NltISCNumber` (always present but
`0` for most). `NltDistrictCode` is the only one worth grouping on. Note the
tenant's custom-field prefix is **`Nlt`**, not the stock Creatio `Usr`.
