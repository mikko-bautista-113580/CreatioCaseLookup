"""Case-lookup domain logic — the read-only query recipes behind the web app,
ported from the /creatio-case-lookup skill and CASE-QUERY-REFERENCE.md.

Everything here goes through the shared read-only client (query_records /
odata_get), so it is GET-only like the rest of the project.

Hard-won gotchas encoded below:
 - Filter through navigation paths (Owner/Id, Account/Id, Status/Name), NEVER
   the FK columns (OwnerId/AccountId/StatusId) — those return HTTP 500.
 - Activity has no queryable CaseId — link emails to a case by matching the
   case number in the Title (contains(Title,'SR...')).
 - Feed/email AUTHORS DO resolve: SocialMessage.CreatedById is a *Contact* Id
   (NOT a SysAdminUnit Id, which is what the old note assumed), so one batched
   Contact read names every poster. Email senders resolve by matching
   Activity.Sender against Contact.Email. Never infer an author from an
   @mention in the body — that is still a guess and has been wrong.

Porting notes: the regexes are translations of the JS originals and are applied
in the same order. JS ``\\s`` / ``trim()`` use a slightly different whitespace
set than Python (JS includes U+FEFF, Python includes U+001C-U+001F and U+0085),
so the JS set is spelled out explicitly as ``_WS``. JS ``.`` without the ``s``
flag excludes ``\\r``, U+2028 and U+2029 as well as ``\\n``.

Rows and details are plain dicts with the TS camelCase keys; a TS field that
would be ``undefined`` is omitted rather than set to ``None``.
"""

from __future__ import annotations

import math
import re
from collections.abc import Callable, Iterable, Mapping
from datetime import datetime, timezone
from typing import Any
from urllib.parse import parse_qsl, urlsplit

from .creatio_client import FILE_DOWNLOAD_ENTITIES, MAX_TOP, odata_get, query_records

# JS whitespace (\s and String.prototype.trim), as a character-class body.
_WS_CHARS = "\t\n\v\f\r    -     　﻿"
_WS = f"[{_WS_CHARS}]"
_TRIM_RE = re.compile(f"^{_WS}+|{_WS}+$")


def _js_trim(s: str) -> str:
    return _TRIM_RE.sub("", s)


# ---------------------------------------------------------------------------
# HTML helpers (verbatim from CASE-QUERY-REFERENCE.md)
# ---------------------------------------------------------------------------
_STRIP_STEPS: list[tuple[re.Pattern[str], Any]] = [
    (re.compile(r"<style[\s\S]*?</style>", re.I), ""),
    (
        re.compile(r'<a[^>]*data-mention-display-value="([^"]*)"[^>]*>.*?</a>', re.S),
        lambda m: "@" + m.group(1),
    ),
    (re.compile(r"<[^>]+>"), " "),
    (re.compile(r"&nbsp;"), " "),
    (re.compile(r"&#39;|&rsquo;"), "'"),
    (re.compile(r"&amp;"), "&"),
    (re.compile(r"&quot;|&ldquo;|&rdquo;"), '"'),
    (re.compile(r"&mdash;"), "-"),
    (re.compile(r"v\\?:\*|o\\?:\*|w\\?:\*|\.shape|\{behavior:url\(#default#VML\);\}"), ""),
    (re.compile(f"{_WS}+"), " "),
]


def strip(h: str | None) -> str:
    s = h or ""
    for rx, repl in _STRIP_STEPS:
        s = rx.sub(repl, s)
    return _js_trim(s)


_REPLY_SPLIT_RE = re.compile(
    f"From:{_WS}|On [^\\n\\r\\u2028\\u2029]{{5,40}} wrote:|Caution: This Message is From an External Sender"
)


def trim_reply(t: str) -> str:
    return _js_trim(_REPLY_SPLIT_RE.split(t)[0])


def _odata_lit(v: str) -> str:
    """Escape a single quote for an OData string literal."""
    return v.replace("'", "''")


# ---------------------------------------------------------------------------
# Status handling
# ---------------------------------------------------------------------------
# Canonical Creatio case statuses the UI offers. "Open / active" is a group.
STATUS_NAMES: tuple[str, ...] = (
    "New",
    "In progress",
    "Waiting for response",
    "Resolved",
    "Closed",
    "Canceled",
)

OPEN_ACTIVE: list[str] = ["New", "In progress", "Waiting for response", "Resolved"]


def _status_filter(statuses: Iterable[str]) -> str | None:
    """Build an OData filter fragment for a set of status names (via Status/Name)."""
    names = [s for s in statuses if s in STATUS_NAMES]
    if not names:
        return None
    return "(" + " or ".join(f"Status/Name eq '{_odata_lit(n)}'" for n in names) + ")"


# ---------------------------------------------------------------------------
# Resolvers (name -> GUIDs), for the disambiguation picker
# ---------------------------------------------------------------------------
async def resolve_owner(name: str) -> list[dict[str, Any]]:
    rows = await query_records(
        "Contact",
        filter=f"contains(Name,'{_odata_lit(name)}')",
        select=["Id", "Name"],
        orderby="Name",
        top=MAX_TOP,
    )
    return [{"Id": r.get("Id"), "Name": r.get("Name")} for r in rows]


async def resolve_account(name: str) -> list[dict[str, Any]]:
    rows = await query_records(
        "Account",
        filter=f"contains(Name,'{_odata_lit(name)}')",
        select=["Id", "Name"],
        orderby="Name",
        top=MAX_TOP,
    )
    return [{"Id": r.get("Id"), "Name": r.get("Name")} for r in rows]


# ---------------------------------------------------------------------------
# Case search
# ---------------------------------------------------------------------------
# SelectMode: "owner" | "account" | "number" | "recent"
# CaseRow keys: Id, Number, Subject, CreatedOn, Status, Owner, Account, Contact
# FindResult keys: cases, truncated, caveats

CASE_EXPAND = "Status($select=Name),Owner($select=Name),Account($select=Name),Contact($select=Name)"
CASE_SELECT = ["Id", "Number", "Subject", "CreatedOn"]


def _put(out: dict[str, Any], key: str, src: Mapping[str, Any], field: str | None = None) -> None:
    """Copy src[field] to out[key] only when present (TS drops undefined)."""
    f = field or key
    if f in src:
        out[key] = src[f]


def _nav_name(r: Mapping[str, Any], nav: str, field: str = "Name") -> Any:
    """``r.nav?.field`` — None when the lookup or field is absent."""
    v = r.get(nav)
    return v.get(field) if isinstance(v, Mapping) else None


def _shape_case(r: Mapping[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for k in ("Id", "Number", "Subject", "CreatedOn"):
        _put(out, k, r)
    for nav in ("Status", "Owner", "Account", "Contact"):
        v = _nav_name(r, nav)
        out[nav] = "" if v is None else v
    return out


async def find_cases(opts: Mapping[str, Any] | None = None, **kw: Any) -> dict[str, Any]:
    """Search cases.

    Options (dict or keywords): mode ("owner"|"account"|"number"|"recent");
    guids (owner/account GUIDs); numbers (SR numbers); statuses; before (ISO
    timestamp — only return cases created before it, to page further back).
    """
    o = {**(opts or {}), **kw}
    mode = o.get("mode")
    caveats: list[str] = []
    clauses: list[str] = []

    if mode == "owner":
        guids = [g for g in (o.get("guids") or []) if g]
        if not guids:
            raise ValueError("No owner selected.")
        clauses.append("(" + " or ".join(f"Owner/Id eq {g}" for g in guids) + ")")
    elif mode == "account":
        guids = [g for g in (o.get("guids") or []) if g]
        if not guids:
            raise ValueError("No account selected.")
        clauses.append("(" + " or ".join(f"Account/Id eq {g}" for g in guids) + ")")
    elif mode == "number":
        nums = [n for n in (_js_trim(x) for x in (o.get("numbers") or [])) if n]
        if not nums:
            raise ValueError("No case number provided.")
        clauses.append("(" + " or ".join(f"Number eq '{_odata_lit(n)}'" for n in nums) + ")")
    # 'recent' => no selector clause

    # Status filter (skip for 'number' lookups — you want the case regardless).
    if mode != "number":
        sf = _status_filter(o.get("statuses") or [])
        if sf:
            clauses.append(sf)

    if o.get("before"):
        clauses.append(f"CreatedOn lt {o['before']}")

    rows = await query_records(
        "Case",
        filter=" and ".join(clauses) if clauses else None,
        expand=CASE_EXPAND,
        select=CASE_SELECT,
        orderby="CreatedOn desc",
        top=MAX_TOP,
    )

    cases = [_shape_case(r) for r in rows]
    truncated = len(cases) >= MAX_TOP
    if truncated:
        caveats.append(
            f'Result hit the {MAX_TOP}-row cap — there may be more. Use "load older" to page further back.'
        )
    return {"cases": cases, "truncated": truncated, "caveats": caveats}


# ---------------------------------------------------------------------------
# Attachments / inline images
# ---------------------------------------------------------------------------
# FileService entities we surface. Everything else (cid:, external tracking
# pixels, arbitrary paths) is dropped. Shared with the download proxy.
ALLOWED_FILE_ENTITIES = FILE_DOWNLOAD_ENTITIES

FILE_SRC_RE = re.compile(r"/0/rest/FileService/Download/([A-Za-z]+)/([0-9a-fA-F-]{36})")

# A rendering segment: escaped text (with newlines) or an image reference.
# The UI escapes text and only emits <img> for these whitelisted sources, so
# no raw Creatio HTML ever reaches the DOM (no XSS surface).
#   {"type": "text", "text": str}
#   {"type": "list", "ordered": bool, "items": [str]}
#   {"type": "image", "entity": str, "id": str}
#   {"type": "image", "dataUri": str}

# Sentinels wrapping an @mention's display name inside segment text.
#
# Private-use code points, so they cannot collide with real case text, and they
# pass through HTML-escaping untouched. The UI escapes first and swaps them for
# a chip afterwards, which keeps the "no raw Creatio HTML reaches the DOM"
# guarantee. Keep these in sync with public/app.js.
MENTION_OPEN = ""
MENTION_CLOSE = ""

# Sentinels wrapping a hyperlink inside segment text: OPEN url SEP label CLOSE.
#
# Same trick as mentions — the UI escapes first, then swaps these for an <a>.
# Only http(s)/mailto URLs are ever wrapped. Keep in sync with public/app.js.
LINK_OPEN = ""
LINK_SEP = ""
LINK_CLOSE = ""
LINK_RE = re.compile(f"{LINK_OPEN}([^{LINK_SEP}]*){LINK_SEP}([^{LINK_CLOSE}]*){LINK_CLOSE}")


def plain_mentions(s: str) -> str:
    """Flatten mention and link sentinels to plain text, for text-only consumers.
    A link keeps its URL ("label <url>") so an AI reader can still see it."""

    def link(m: re.Match[str]) -> str:
        url, label = m.group(1), m.group(2)
        bare = re.sub(r"^mailto:", "", url, flags=re.I)
        return bare if (not label or label == url or label == bare) else f"{label} <{url}>"

    s = s.replace(MENTION_OPEN, "@").replace(MENTION_CLOSE, "")
    return LINK_RE.sub(link, s)


_SAFELINKS_HOST_RE = re.compile(r"\.safelinks\.protection\.outlook\.com$", re.I)
_SAFE_URL_RE = re.compile(f"(?:https?://|mailto:)[^{_WS_CHARS}\\ue000-\\ue004]+", re.I)
_SCHEME_RE = re.compile(r"[A-Za-z][A-Za-z0-9+.\-]*:")


def _safe_href(raw: str) -> str | None:
    """Resolve an <a href> to a URL safe to show, or None to drop the link.

    Outlook SafeLinks wrappers are unwrapped to the real target — the wrapper
    is long, tracks the click, and hides where the file actually lives (e.g.
    the FTP mock-up PDFs customers link from their request emails).

    JS ``new URL()`` throws on relative/malformed input; urlsplit never does,
    so an absolute URL is required explicitly (a scheme, plus a host for the
    hierarchical http(s) schemes).
    """
    href = _js_trim(_decode_entities(raw))
    if not _SCHEME_RE.match(href):
        return None  # relative or malformed
    try:
        u = urlsplit(href)
        host = u.hostname or ""
        if u.scheme.lower() in ("http", "https") and not host:
            return None
        if _SAFELINKS_HOST_RE.search(host):
            inner = next((v for k, v in parse_qsl(u.query, keep_blank_values=True) if k == "url"), "")
            if inner:
                href = inner
    except ValueError:
        return None
    return href if _SAFE_URL_RE.fullmatch(href) else None


_DECODE_STEPS: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"&nbsp;"), " "),
    (re.compile(r"&#39;|&rsquo;"), "'"),
    (re.compile(r"&quot;|&ldquo;|&rdquo;"), '"'),
    (re.compile(r"&mdash;"), "-"),
    (re.compile(r"&lt;"), "<"),
    (re.compile(r"&gt;"), ">"),
    (re.compile(r"&amp;"), "&"),
]


def _decode_entities(s: str) -> str:
    """Decode the handful of entities strip() handles, but KEEP newlines."""
    for rx, repl in _DECODE_STEPS:
        s = rx.sub(repl, s)
    return s


_SEG_STYLE_RE = re.compile(r"<style[\s\S]*?</style>", re.I)
_SEG_COMMENT_RE = re.compile(r"<!--[\s\S]*?-->")
_SEG_MENTION_RE = re.compile(r'<a[^>]*data-mention-display-value="([^"]*)"[^>]*>[\s\S]*?</a>', re.I)
_SEG_LINK_RE = re.compile(
    f'<a\\b[^>]*?\\bhref{_WS}*={_WS}*"([^"]*)"[^>]*>([\\s\\S]*?)</a>', re.I | re.A
)
_TAG_RE = re.compile(r"<[^>]+>")
_SENTINEL_RE = re.compile("[-]")
_TOKEN_RE = re.compile(
    r"<img\b[^>]*>|<(?:ul|ol)\b[^>]*>|</(?:ul|ol)>|<li\b[^>]*>|</li>|</(?:div|p|tr|h[1-6])>"
    f"|<br{_WS}*/?>|<[^>]+>|[^<]+",
    re.I | re.A,
)
_IMG_SRC_RE = re.compile(f'src{_WS}*={_WS}*"([^"]*)"', re.I)
_DATA_IMG_RE = re.compile(r"^data:image/(png|jpe?g|gif|webp|bmp);base64,", re.I)
_ZW_RE = re.compile("[​-‍﻿]")
_CRLF_RE = re.compile(r"\r\n?")
_INNER_WS_RE = re.compile(r"[ \t]{2,}")
_MANY_NL_RE = re.compile(r"\n{3,}")


def html_to_segments(html: str | None) -> list[dict[str, Any]]:
    """Turn Creatio rich-text HTML into ordered text/image segments. Block tags
    and <br> become newlines; whitelisted FileService images and data: images
    become image segments (in place); all other tags are dropped."""

    def link(m: re.Match[str]) -> str:
        url = _safe_href(m.group(1))
        if not url:
            return m.group(0)
        label = _js_trim(_SENTINEL_RE.sub("", _TAG_RE.sub("", m.group(2))))
        return LINK_OPEN + url + LINK_SEP + label + LINK_CLOSE

    src = html or ""
    src = _SEG_STYLE_RE.sub("", src)
    src = _SEG_COMMENT_RE.sub("", src)
    # A mention is an <a> wrapping an avatar <span> whose text is the person's
    # first initial. Tokenized verbatim that reads "NNolan Kelliher", so replace
    # the whole anchor with just its display name, between mention sentinels.
    src = _SEG_MENTION_RE.sub(lambda m: MENTION_OPEN + m.group(1) + MENTION_CLOSE, src)
    # Keep ordinary hyperlinks (tags inside the label are dropped). An unsafe
    # or relative href falls through, leaving just the label text.
    src = _SEG_LINK_RE.sub(link, src)

    segs: list[dict[str, Any]] = []
    buf = ""
    # Non-None while inside <ul>/<ol>, so each <li> becomes its own item instead
    # of running together into one paragraph.
    lst: dict[str, Any] | None = None

    def take() -> str:
        """Drain the buffer as one normalized block.

        Creatio pretty-prints its HTML, so block tags and <li> arrive wrapped in
        literal tabs and newlines. Left alone those survive into the UI as a
        ragged indent. Normalize per line — NBSP to a plain space, inner runs
        collapsed, and whitespace that only came from source formatting dropped
        — so every block starts at the same left edge.
        """
        nonlocal buf
        t = _decode_entities(buf).replace(" ", " ")
        # Zero-width junk Creatio's editor leaves behind, mostly around mentions.
        t = _ZW_RE.sub("", t)
        t = _CRLF_RE.sub("\n", t)
        t = "\n".join(_js_trim(_INNER_WS_RE.sub(" ", line)) for line in t.split("\n"))
        t = _js_trim(_MANY_NL_RE.sub("\n\n", t))
        buf = ""
        return t

    def flush_text() -> None:
        t = take()
        if t:
            segs.append({"type": "text", "text": t})

    def flush_item() -> None:
        t = take()
        if t and lst is not None:
            lst["items"].append(t)

    def close_list() -> None:
        nonlocal lst
        if lst is None:
            return
        flush_item()
        if lst["items"]:
            segs.append({"type": "list", "ordered": lst["ordered"], "items": lst["items"]})
        lst = None

    for m in _TOKEN_RE.finditer(src):
        tok = m.group(0)
        if re.match(r"<img", tok, re.I):
            sm = _IMG_SRC_RE.search(tok)
            s = (sm.group(1) if sm else "") or ""
            fs = FILE_SRC_RE.search(s)

            def emit(seg: dict[str, Any]) -> None:
                if lst is not None:
                    flush_item()
                else:
                    flush_text()
                segs.append(seg)

            if fs and fs.group(1) in ALLOWED_FILE_ENTITIES:
                emit({"type": "image", "entity": fs.group(1), "id": fs.group(2)})
            elif _DATA_IMG_RE.search(s):
                emit({"type": "image", "dataUri": s})
            # else: drop (cid:, external tracking, unknown)
        elif re.match(r"<(?:ul|ol)\b", tok, re.I | re.A):
            # A nested list just continues as a flat one — good enough for case
            # text, and far less fragile than tracking depth.
            close_list()
            flush_text()
            lst = {"ordered": bool(re.match(r"<ol", tok, re.I)), "items": []}
        elif re.fullmatch(r"</(?:ul|ol)>", tok, re.I):
            close_list()
        elif re.match(r"<li\b", tok, re.I | re.A) or re.fullmatch(r"</li>", tok, re.I):
            if lst is not None:
                flush_item()
            else:
                buf += "\n"
        elif re.fullmatch(r"</(?:div|p|tr|h[1-6])>", tok, re.I) or re.match(r"<br", tok, re.I):
            buf += "\n"
        elif re.fullmatch(r"<[^>]+>", tok):
            pass  # other tag: ignore
        else:
            buf += tok
    close_list()
    flush_text()
    return segs


_IMG_TAG_RE = re.compile(r"<img\b[^>]*>", re.I | re.A)


def extract_file_images(html: str | None) -> list[dict[str, str]]:
    """Extract only real file attachments (whitelisted FileService) from HTML,
    ignoring inline data:/cid:/external noise. Deduped, order-preserving."""
    out: list[dict[str, str]] = []
    seen: set[str] = set()
    for tag in _IMG_TAG_RE.findall(html or ""):
        sm = _IMG_SRC_RE.search(tag)
        s = (sm.group(1) if sm else "") or ""
        fs = FILE_SRC_RE.search(s)
        if fs and fs.group(1) in ALLOWED_FILE_ENTITIES and fs.group(2) not in seen:
            seen.add(fs.group(2))
            out.append({"entity": fs.group(1), "id": fs.group(2)})
    return out


# ---------------------------------------------------------------------------
# Detail: description, timeline
# ---------------------------------------------------------------------------
async def get_description(case_id: str) -> dict[str, Any]:
    """``{"text": plain text (AI context / fallback), "segments": [...] (UI)}``."""
    data = await odata_get(f"Case({case_id})?$select=Symptoms")
    html = (data.get("Symptoms") if isinstance(data, dict) else None) or ""
    return {"text": strip(html), "segments": html_to_segments(html)}


# TimelineEntry keys: kind ("FEED"|"EMAIL"), ts, text, segments? (feed),
# images? (email), title?/sender?/recipient? (email), author?, authorId?.
# `author` is left out when it could not be resolved — the UI says
# "Unknown author" rather than showing a GUID.

EMPTY_GUID = "00000000-0000-0000-0000-000000000000"
# OR-chains get long fast, and an over-long filter is what makes Creatio 500.
CONTACT_BATCH = 20

_EMAIL_RE = re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+", re.A)


def _email_address(v: str | None) -> str:
    """Pull the bare address out of "Name <a@b.c>" or a raw address."""
    m = _EMAIL_RE.search(v or "")
    return m.group(0).lower() if m else ""


def _js_string(v: Any) -> str:
    """JS ``String(v)`` for JSON values (``null``/``undefined`` handled by callers)."""
    if v is True:
        return "true"
    if v is False:
        return "false"
    if isinstance(v, float) and v.is_integer():
        return str(int(v))
    return str(v)


async def _contact_map(
    values: Iterable[str | None], clause: Callable[[str], str], key: str
) -> dict[str, str]:
    """Batched Contact lookups, keyed by whichever column was matched.

    Best-effort by design: naming a poster is a nicety, so a failed read
    (Contact missing from the allowlist, an expired cookie) yields an empty
    map and the timeline still renders — it just says "Unknown author".
    """
    out: dict[str, str] = {}
    unique = list(dict.fromkeys(v for v in values if v and v != EMPTY_GUID))
    for i in range(0, len(unique), CONTACT_BATCH):
        chunk = unique[i : i + CONTACT_BATCH]
        try:
            rows = await query_records(
                "Contact",
                filter=" or ".join(clause(v) for v in chunk),
                select=["Id", "Name", "Email"],
                top=len(chunk),
            )
            for r in rows:
                raw = r.get(key)
                k = ("" if raw is None else _js_string(raw)).lower()
                if k and r.get("Name"):
                    out[k] = r["Name"]
        except Exception:  # noqa: BLE001
            pass  # leave this chunk unresolved
    return out


def js_date_ms(v: Any) -> float:
    """``new Date(v).getTime()`` for ISO strings; NaN when unparseable.

    A date-only string is UTC (as in JS); a date-time without an offset is local
    time (as in JS, and as Python's naive ``timestamp()`` assumes).
    """
    if not isinstance(v, str) or not v.strip():
        return math.nan
    s = v.strip()
    try:
        if re.fullmatch(r"\d{4}-\d{2}-\d{2}", s):
            return datetime.fromisoformat(s).replace(tzinfo=timezone.utc).timestamp() * 1000
        return datetime.fromisoformat(s).timestamp() * 1000
    except ValueError:
        return math.nan


async def get_timeline(case_id: str, case_number: str) -> list[dict[str, Any]]:
    # Feed posts, linked by EntityId = the Case Id.
    feed = await query_records(
        "SocialMessage",
        filter=f"EntityId eq {case_id}",
        select=["Id", "Message", "CreatedOn", "CreatedById"],
        orderby="CreatedOn asc",
        top=MAX_TOP,
    )

    # Emails, linked by the case number stamped into the Title (no queryable CaseId).
    mail = await query_records(
        "Activity",
        filter=f"contains(Title,'{_odata_lit(case_number)}')",
        select=["Id", "Title", "CreatedOn", "Sender", "Recepient", "SendDate", "Body"],
        orderby="CreatedOn asc",
        top=MAX_TOP,
    )

    # Name the posters. CreatedById is a Contact Id, so the whole feed resolves
    # in one batched read; email senders are matched on their address.
    by_id = await _contact_map(
        (f.get("CreatedById") for f in feed), lambda id_: f"Id eq {id_}", "Id"
    )
    by_email = await _contact_map(
        (_email_address(m.get("Sender")) for m in mail),
        lambda e: f"Email eq '{_odata_lit(e)}'",
        "Email",
    )

    entries: list[dict[str, Any]] = []
    for f in feed:
        e: dict[str, Any] = {"kind": "FEED"}
        _put(e, "ts", f, "CreatedOn")
        e["text"] = strip(f.get("Message"))
        # Clean rich text: render inline (incl. FeedFile images).
        e["segments"] = html_to_segments(f.get("Message"))
        _put(e, "authorId", f, "CreatedById")
        author = by_id.get(str(f.get("CreatedById") or "").lower())
        if author is not None:
            e["author"] = author
        entries.append(e)
    for m in mail:
        e = {"kind": "EMAIL"}
        _put(e, "ts", m, "CreatedOn")
        _put(e, "title", m, "Title")
        _put(e, "sender", m, "Sender")
        # Note: Creatio's field is misspelled "Recepient".
        _put(e, "recipient", m, "Recepient")
        # Fall back to the raw address — it still tells you who wrote.
        author = by_email.get(_email_address(m.get("Sender"))) or m.get("Sender")
        if author:
            e["author"] = author
        e["text"] = trim_reply(strip(m.get("Body")))
        # Only real attachments; skip signature/tracking noise.
        e["images"] = extract_file_images(m.get("Body"))
        entries.append(e)

    # Stable sort by date (Array.prototype.sort is stable). Unparseable
    # timestamps sort first rather than poisoning the comparison.
    def key(entry: dict[str, Any]) -> float:
        t = js_date_ms(entry.get("ts"))
        return -math.inf if math.isnan(t) else t

    entries.sort(key=key)
    return entries


# ---------------------------------------------------------------------------
# Detail: extra fields
# ---------------------------------------------------------------------------
_EXTRA_KEYS = (
    "RegisteredOn",
    "ModifiedOn",
    "ResponseDate",
    "SolutionDate",
    "SolutionOverdue",
    "NltHoursWorked",
)


async def get_attachments(case_id: str) -> list[dict[str, Any]]:
    """Files on the case's Attachments tab (``{id, name, size, createdOn}``).

    Goes through query_records, so the entity allowlist still applies:
    `CaseFile` must be in CREATIO_ALLOWED_ENTITIES or this raises. Only metadata
    is read — the bytes are served separately by the read-only /api/file proxy,
    which already permits CaseFile.

    `Case/Id eq <guid>` is the navigation path; the guid is NOT quoted, and
    filtering on a `CaseId` column would fail the same way it does elsewhere.
    """
    rows = await query_records(
        "CaseFile",
        select=["Id", "Name", "Size", "CreatedOn"],
        filter=f"Case/Id eq {case_id}",
        orderby="CreatedOn desc",
        top=25,
    )
    out: list[dict[str, Any]] = []
    for r in rows:
        a: dict[str, Any] = {}
        _put(a, "id", r, "Id")
        a["name"] = r.get("Name") or ""
        a["size"] = _js_number(r.get("Size"))
        a["createdOn"] = r.get("CreatedOn") or ""
        out.append(a)
    return out


def _js_number(v: Any) -> int | float:
    """``Number(v) || 0``."""
    if v is None or isinstance(v, bool):
        return int(bool(v))
    try:
        n = float(v) if not isinstance(v, (int, float)) else v
    except (TypeError, ValueError):
        return 0
    if isinstance(n, float):
        if math.isnan(n) or math.isinf(n):
            return 0 if math.isnan(n) else n
        if n.is_integer():
            return int(n)
    return n or 0


async def get_extra_fields(case_id: str) -> dict[str, Any]:
    data = await odata_get(
        f"Case({case_id})?$select=RegisteredOn,ModifiedOn,ResponseDate,SolutionDate,SolutionOverdue,NltHoursWorked"
    )
    data = data if isinstance(data, dict) else {}
    return {k: data[k] for k in _EXTRA_KEYS if k in data}


# ---------------------------------------------------------------------------
# Detail: Case info (Creatio's left-hand "Case info" panel)
# ---------------------------------------------------------------------------
# CaseInfoField keys: label, value, link? (rendered as a link), required?, date?

# The panel's fields, in Creatio's order, as one read. Column names were
# verified against live records (a wrong name in $select/$expand fails the
# whole query). SIS District code and Institution ID live on the Account, not
# the Case — Creatio's panel pulls them through the Account lookup.
CASE_INFO_QUERY = (
    "$select=Id,SolutionDate,NltSchoolCode"
    "&$expand=Contact($select=Name),Account($select=Name,NltDistrictCode,NltInstNum),"
    "Priority($select=Name),Category($select=Name),ServiceItem($select=Name),"
    "NltServiceArea($select=Name),NltCaseType($select=Name)"
)


async def get_case_info(case_id: str) -> list[dict[str, Any]]:
    r = await odata_get(f"Case({case_id})?{CASE_INFO_QUERY}") or {}
    if not isinstance(r, dict):
        r = {}

    def s(v: Any) -> str:
        return "" if v is None else _js_string(v)

    return [
        {"label": "Contact", "value": s(_nav_name(r, "Contact")), "link": True},
        {"label": "Account", "value": s(_nav_name(r, "Account")), "link": True, "required": True},
        {"label": "Priority", "value": s(_nav_name(r, "Priority")), "link": True},
        {"label": "Category", "value": s(_nav_name(r, "Category"))},
        {"label": "Service", "value": s(_nav_name(r, "ServiceItem")), "link": True, "required": True},
        {"label": "Service Area", "value": s(_nav_name(r, "NltServiceArea")), "required": True},
        {"label": "Case Type", "value": s(_nav_name(r, "NltCaseType"))},
        {"label": "Resolution time", "value": s(r.get("SolutionDate")), "date": True},
        {"label": "SIS District code", "value": s(_nav_name(r, "Account", "NltDistrictCode"))},
        {"label": "School Code", "value": s(r.get("NltSchoolCode"))},
        {"label": "Institution ID Number", "value": s(_nav_name(r, "Account", "NltInstNum"))},
    ]


# ---------------------------------------------------------------------------
# Orchestration: fetch requested detail for a set of cases
# ---------------------------------------------------------------------------
# DetailKind: "summary" | "description" | "timeline" | "latest" | "extra"
#             | "caseinfo" | "attachments"
# CaseDetail keys: description?, descriptionSegments?, timeline?, latest?
#                  (None when empty), extra?, caseInfo?, attachments?,
#                  attachmentsError? (attachments requested but not listable).


async def get_case_detail(c: Mapping[str, Any], detail: Iterable[str]) -> dict[str, Any]:
    """Fetch the requested detail kinds for one case. `summary` needs no extra call."""
    out: dict[str, Any] = {}
    want = set(detail)

    if "description" in want:
        d = await get_description(c.get("Id"))
        out["description"] = d["text"]
        out["descriptionSegments"] = d["segments"]

    if "timeline" in want or "latest" in want:
        tl = await get_timeline(c.get("Id"), c.get("Number"))
        if "timeline" in want:
            out["timeline"] = tl
        if "latest" in want:
            out["latest"] = tl[-1] if tl else None

    if "extra" in want:
        out["extra"] = await get_extra_fields(c.get("Id"))
    if "caseinfo" in want:
        out["caseInfo"] = await get_case_info(c.get("Id"))
    if "attachments" in want:
        # A missing CaseFile allowlist entry shouldn't sink the rest of the detail.
        try:
            out["attachments"] = await get_attachments(c.get("Id"))
        except Exception as e:  # noqa: BLE001
            out["attachmentsError"] = str(e)

    return out
