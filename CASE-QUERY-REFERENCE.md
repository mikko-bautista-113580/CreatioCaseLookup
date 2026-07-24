# Creatio Case Query Reference

Practical notes for pulling **specific information about a Case** (and its
Timeline) from `https://nelnet.creatio.com` via the read-only OData 4 endpoint.
Built from real queries — includes the gotchas that aren't obvious.

---

## 1. Auth (how requests are made)

- **Mode:** cookie auth (SSO tenant — no local password).
- **Credentials live in** `c:\neldevsrc\creatio-mcp\.env`:
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
