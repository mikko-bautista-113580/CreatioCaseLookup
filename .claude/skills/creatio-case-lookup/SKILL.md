---
name: creatio-case-lookup
description: Interactively look up Creatio Support cases and pull exactly the detail the user wants. Walks the user through three multiple-choice prompts — (1) which cases to get, (2) which statuses to include, (3) what detail to return (summary, full description, conversation/timeline, latest update, extra fields) — then queries Creatio via the read-only OData MCP tools and reports the results. Use when the user wants to find cases (by assignee/owner, case number, or account), check case status, or read a case's description or conversation history.
---

# Creatio Case Lookup

An interactive workflow for retrieving Creatio Support cases. You ask the user
**three multiple-choice questions** (using the `AskUserQuestion` tool), then run
the appropriate read-only OData queries and report back.

Always read `CASE-QUERY-REFERENCE.md` at the repo root for the authoritative
query recipes and gotchas — the essentials are embedded below. All queries are
**read-only**; never attempt writes.

## Prerequisites

- The `mcp__creatio-readonly__*` tools must be loaded. If they are not in the
  tool list, load them first with `ToolSearch`:
  `select:mcp__creatio-readonly__creatio_query_records,mcp__creatio-readonly__creatio_get_record,mcp__creatio-readonly__creatio_list_allowed_entities`
- Allowlisted entities: **Case, Activity, Contact, Account, SocialMessage**.
  Row cap is **50** per query (`top` is clamped to 50).
- Cookie auth can expire (401/403). If queries start failing with auth errors,
  tell the user the Creatio cookies in `.env` need refreshing (see
  `CASE-QUERY-REFERENCE.md` §1) — you cannot fix this yourself.

---

## Step 1 — Ask WHICH cases (Question 1)

Use `AskUserQuestion` with a single question, header `"Select by"`, options:

1. **By assignee / owner** — cases owned by a specific person (most common).
2. **By case number** — one or more specific `SRxxxxxxxx` numbers.
3. **By account / school** — all cases for a school/organization.
4. **All recent cases** — the newest cases regardless of owner.

Because the selection needs a concrete value (a name, a number, an account),
after the user picks a mode, **ask a plain follow-up** for the specific value
unless they already gave it in the original request or via "Other":
- assignee → ask for the person's name
- case number → ask for the `SR...` number(s)
- account → ask for the school/account name

### Resolving the selector to a filter

**Assignee / owner** — resolve the name to a Contact GUID first, then filter by
the Owner **navigation path** (NOT `OwnerId`, which is not a filterable column):

```
Contact  $filter=contains(Name,'<lastname>')  $select=Id,Name
```
- If multiple contacts match (common — there are several similarly-named
  people), list them and ask the user which one, OR query all candidate GUIDs
  together and group the results by `Owner/Name` so it's obvious.
- Then:
```
Case
  $filter = Owner/Id eq <guid> [or Owner/Id eq <guid2> ...]
  $expand = Status($select=Name),Owner($select=Name)
  $select = Id,Number,Subject,CreatedOn,StatusId
  $orderby = CreatedOn desc
  $top = 50
```

**Case number(s):**
```
Case  $filter=Number eq 'SR00031980' [or Number eq 'SR00026236' ...]
      $expand=Status($select=Name),Account($select=Name),Contact($select=Name),Owner($select=Name)
```

**Account / school** — resolve the account, then filter cases by
`Account/Id eq <guid>` (same navigation-path pattern as Owner).

**All recent** — no owner filter; just `$orderby=CreatedOn desc $top=50`.

> ⚠️ **Filter columns:** foreign keys like `OwnerId`, `AccountId`, `StatusId`
> appear in query *output* but are NOT filterable — filtering on them returns
> HTTP 500 (`Column by path <X>Id not found`). Always filter through the
> navigation property: `Owner/Id`, `Account/Id`, `Status/Name`.

---

## Step 2 — Ask WHICH statuses (Question 2)

Use `AskUserQuestion`, header `"Status"`, **`multiSelect: true`**, options drawn
from the Creatio case statuses:

- **Open / active only** (New, In progress, Waiting for response, Resolved) — recommended default
- **New**
- **In progress**
- **Waiting for response**
- **Resolved**
- **Closed**
- **Canceled**
- **All statuses**

Because `CaseStatus` is **not** in the allowlist, you cannot query the status
lookup table directly. Resolve/handle status two ways:

1. **Preferred — server-side filter** by status name via the navigation path,
   combined with the Step 1 filter, e.g.:
   `Owner/Id eq <guid> and Status/Name eq 'New'`
   (for multiple statuses: `(Status/Name eq 'New' or Status/Name eq 'In progress')`).
2. **Fallback** — if a `Status/Name` filter errors, retrieve with
   `$expand=Status($select=Name)` and filter the results in-memory by the
   `Status.Name` values the user chose.

Known `StatusId` → name map (observed; use only as a cross-check, prefer
resolving live via `expand`):

| StatusId | Name |
|----------|------|
| `3859c6e7-cbcb-486b-ba53-77808fe6e593` | Waiting for response |
| `7e9f1204-f46b-1410-fb9a-0050ba5d6c38` | In progress |
| `ae7f411e-f46b-1410-009b-0050ba5d6c38` | Resolved |
| `3e7f420c-f46b-1410-fc9a-0050ba5d6c38` | Closed |

> **50-row cap / pagination:** if a result set hits 50 rows there may be more.
> To page further back, repeat the query adding
> `and CreatedOn lt <oldest CreatedOn from last page>`. Tell the user when a
> result set was truncated rather than implying it's complete.

---

## Step 3 — Ask WHAT detail to return (Question 3)

Use `AskUserQuestion`, header `"Include"`, **`multiSelect: true`**, options:

1. **Summary table** (default — number, subject, status, account, contact, created date)
2. **Full description** — the case `Symptoms` field (the original request), HTML-stripped
3. **Conversation / timeline** — full feed posts + emails, merged chronologically
4. **Latest update only** — just the most recent timeline entry per case
5. **Extra fields** — dates, priority, hours (`NltHoursWorked`), service item, etc.

If the user selected many cases (say > 5) and asks for full conversation, warn
that it's several queries per case and offer to limit to the latest update or a
subset first.

### Fetching descriptions
`Symptoms` is HTML. Fetch it in the Case `$select` (or via `creatio_get_record`
by Id) and strip tags before presenting (see strip helper in the reference).

### Fetching the conversation / timeline (per case)
The Timeline tab is a **composite of two entities** — query both and merge by
`CreatedOn`:

1. **Feed posts** → `SocialMessage`, linked by `EntityId` = the Case Id:
```
SocialMessage  $filter=EntityId eq <CaseGuid>  $select=Id,Message,CreatedOn
               $orderby=CreatedOn desc  $top=50
```
`Message` is HTML (may contain `@mention` anchors).

2. **Emails** → `Activity`. There is **no queryable `Activity.CaseId`** (returns
   HTTP 500). Link by matching the case number in the Title instead:
```
Activity  $filter=contains(Title,'SR00031980')
          $select=Id,Title,CreatedOn,Sender,Recepient,SendDate  (note: "Recepient" spelling)
          $orderby=CreatedOn desc  $top=50
```

Tag each row FEED vs EMAIL, merge, sort by `CreatedOn`, strip HTML bodies, and
for emails trim quoted-reply history (cut at `From:` / `On … wrote:` /
`Caution: This Message is From an External Sender`).

> ℹ️ **Name the author from `Contact`, never from an `@mention`.**
> `SocialMessage.CreatedById` is a `Contact` Id, so
> `Contact?$filter=Id eq <CreatedById>&$select=Id,Name` gives you the poster
> (batch the ids, ≤20 per request). Email senders match `Contact.Email`. If a
> lookup returns nothing, say the author is unknown — an `@mention` names who
> is being addressed, not who wrote, and reading it as the author has been
> wrong before.

---

## Output

- Lead with a compact summary table for the selected cases (number, subject,
  status, account/contact, created).
- Add a short status tally when several cases are returned.
- Then append the requested detail (description / timeline / latest update /
  extra fields) per case, in the order chosen.
- Convert relative timestamps to absolute dates.
- Note any caveats: result truncation (50-cap), multiple owner matches, any
  author that didn't resolve, empty email bodies.
- End by offering the obvious next step (e.g. full email bodies, page further
  back, open a linked report-card template).

## HTML-strip helper (for `Message` / `Body` / `Symptoms`)
```js
const strip = h => (h||'')
  .replace(/<style[\s\S]*?<\/style>/gi,'')
  .replace(/<a[^>]*data-mention-display-value="([^"]*)"[^>]*>.*?<\/a>/gs,'@$1')
  .replace(/<[^>]+>/g,' ')
  .replace(/&nbsp;/g,' ').replace(/&#39;|&rsquo;/g,"'").replace(/&amp;/g,'&')
  .replace(/&quot;|&ldquo;|&rdquo;/g,'"').replace(/&mdash;/g,'-')
  .replace(/\s+/g,' ').trim();
```
