"""Turn a case brief into a short list of weighted search terms.

Pure and deterministic — no model, no I/O. The terms drive two rankings:
which workspace files are related to the case (case_files.py) and which
team-wiki pages are (wiki_select.py).

SANITIZED BY CONSTRUCTION: every term is lowercased, reduced to
[a-z0-9 .#_-] and at most 40 characters, and there are at most MAX_TERMS of
them. That is what lets the case-scoped analysis receive the terms without
receiving case prose — a client can't smuggle an instruction through a list
of short keyword tokens. See the trust note in analyze_workspace.py.

A term is a dict ``{"term": str, "weight": number, "kind": "code"|"file"|"phrase"|"word"}``
(the TS CaseTerm shape). A brief is a dict with subject/description/timeline/account.
"""

from __future__ import annotations

import re
from typing import Any

from .workspace import js_round1, locale_key

MAX_TERMS = 20
MAX_TERM_CHARS = 40
TIMELINE_ENTRIES = 10

# Domain phrases that always count, on top of the wiki's own page titles.
BUILTIN_PHRASES = [
    "report card",
    "progress report",
    "transcript",
    "web form",
    "maintenance job",
    "honor roll",
    "state report",
    "gpa",
    "gradebook",
    "attendance",
    "schedule",
    "label",
    "census",
    "diocese",
    "standards",
    "logo",
    "comment",
    "signature",
    "export",
    "import",
    "integration",
    "skillset",
    "homeroom",
    "hr class",
    "final grade",
    "term columns",
    "student id",
    "color scheme",
]

STOPWORDS = set(
    (
        "a an the and or but if then else of to in on at by for with from as is are was were be been being "
        "it its this that these those there here i we you he she they me us him her them my our your their "
        "do does did done have has had not no yes can could would should will shall may might must "
        "please thanks thank hello hi hey dear regards best kind sincerely team support ticket case "
        "sr issue problem help need needs want wants like just also still again any some all more most "
        "very so too get got see seen look looks looking know let lets make made use used using work works "
        "working new old one two three first last next time today tomorrow yesterday day week "
        "email sent send attached attachment below above following would like able fix fixed update updated "
        "school facts renweb client customer thing things way "
        # File extensions and request boilerplate: everywhere in a report folder,
        # so they rank everything equally and pick nothing.
        "cfm cfc htm html sql css jpg jpeg png gif pdf doc docx xls xlsx csv txt "
        "template templates sample samples refer required change changes pull pulls pulling display "
        "replace remove removed section below correspond numbered items item proceed approved hours "
        "checked check will shall into each under which what when where who whom how than"
    ).split()
)

# JS `\s` (includes ﻿ and the Unicode spaces) and JS `.` (no line terminators).
_JS_S = r"[\s﻿]"
_JS_DOT = r"[^\n\r  ]"
_REPLY_RE = re.compile(
    rf"(^|\n){_JS_S}*(From:|-----{_JS_S}*Original Message|On {_JS_DOT}{{3,80}} wrote:|Caution: This Message is From an External Sender)",
    re.IGNORECASE,
)


def trim_reply(text: str) -> str:
    """Drop quoted reply history from an email body."""
    s = str(text or "")
    m = _REPLY_RE.search(s)
    cut = m.start() if m else -1
    return s[:cut] if cut > 0 else s


def normalize_text(t: str) -> str:
    """Lowercase and reduce to the term alphabet, keeping the full length — for matching text."""
    s = str(t or "").lower()
    s = re.sub(r"[^a-z0-9 .#_-]+", " ", s)
    s = re.sub(r" +", " ", s)
    return s.strip(" ")


def sanitize_term(t: str) -> str:
    """A single term: normalized AND bounded to MAX_TERM_CHARS."""
    return normalize_text(t)[:MAX_TERM_CHARS].strip(" ")


def vocabulary_from_titles(paths: list[str]) -> list[str]:
    """Vocabulary taken from the wiki's page titles: every one- and two-word run in
    a leaf title. Keeps the phrase list in step with what the team documents
    (Canvas, Clever, OneRoster, GPA Calculator…) without a hard-coded list."""
    out: dict[str, None] = {}  # insertion-ordered set
    for p in paths:
        title = p.split("/")[-1] or ""
        words = [
            w for w in sanitize_term(re.sub(r"[-_]", " ", title)).split(" ")
            if len(w) > 2 and w not in STOPWORDS
        ]
        for i, w in enumerate(words):
            out[w] = None
            if i + 1 < len(words):
                out[f"{w} {words[i + 1]}"] = None
    return list(out)


_ALNUM = frozenset("abcdefghijklmnopqrstuvwxyz0123456789")


def count_term_hits(hay: str, needle: str) -> int:
    """How many times `needle` occurs word-bounded in `hay`.

    Exactly the count of the TS global regex
    ``/(^|[^a-z0-9])needle(?=$|[^a-z0-9])/g`` — including that each match
    CONSUMES the boundary character before it, so a match can't start right
    where the previous one ended — but done with str.find, which is orders of
    magnitude faster than a Python regex scan over large templates.
    """
    if not needle:
        return 0
    n, ln = len(hay), len(needle)
    count = 0
    pos = 0  # where the regex's next attempt starts
    j = hay.find(needle, 0)
    while j != -1:
        ok_before = (j == 0 and pos == 0) or (j - 1 >= pos and hay[j - 1] not in _ALNUM)
        end = j + ln
        ok_after = end == n or hay[end] not in _ALNUM
        if ok_before and ok_after:
            count += 1
            pos = end
            j = hay.find(needle, end)
        else:
            j = hay.find(needle, j + 1)
    return count


_count_occurrences = count_term_hits


_KIND_RANK = ["code", "file", "phrase", "word"]
_CODE_RE = re.compile(r"\b([A-Z]{2,6}-[A-Z]{2,6})\b", re.ASCII)
_FILE_RE = re.compile(r"\b([\w-]{2,60}\.(?:cfm|cfc|htm|html|sql|js|css|xml))\b", re.ASCII | re.IGNORECASE)


def extract_case_terms(brief: dict[str, Any], vocabulary: list[str] | None = None) -> list[dict]:
    """Extract weighted terms from a brief.

    Sources and weights: subject ×3, description ×2, the latest timeline entries
    ×1 (quoted replies trimmed). School codes ("EP-JAM") and file names
    ("ReportCard.cfm") are the strongest signals a case carries, so they get a
    fixed high weight whenever they appear anywhere.
    """
    vocabulary = vocabulary or []
    timeline = brief.get("timeline") or []
    tl = [trim_reply((t or {}).get("text", "")) for t in timeline[-TIMELINE_ENTRIES:]]
    sources: list[tuple[str, float]] = [
        (brief.get("subject") or "", 3),
        (brief.get("description") or "", 2),
        *[(text, 1) for text in tl],
    ]
    raw_all = "\n".join(s[0] for s in sources)

    scores: dict[str, dict] = {}

    def add(term: str, weight: float, kind: str) -> None:
        t = sanitize_term(term)
        if not t or len(t) < 2:
            return
        cur = scores.get(t)
        if cur:
            cur["weight"] += weight
            # Keep the strongest kind a term was seen as.
            if _KIND_RANK.index(kind) < _KIND_RANK.index(cur["kind"]):
                cur["kind"] = kind
        else:
            scores[t] = {"weight": weight, "kind": kind}

    # School codes: two uppercase groups joined by a hyphen, as the report folders use.
    # Their pieces ("ep", "jam") are fragments, not words worth searching for.
    fragments: set[str] = set()
    for m in _CODE_RE.finditer(raw_all):
        add(m.group(1), 10, "code")
        for part in m.group(1).lower().split("-"):
            fragments.add(part)
    # The district and school codes from Creatio's Case info, when the brief has
    # them: the authoritative pointer to the client's folder, whatever the text
    # says. A purely numeric code is an id, not a folder name, so it's skipped.
    codes = brief.get("codes") or {}
    for key in ("districtCode", "schoolCode"):
        code = str(codes.get(key) or "").strip()
        if code and not code.isdigit():
            add(code, 10, "code")
            for part in re.split(r"[-_]", code.lower()):
                fragments.add(part)
    # File names mentioned outright — the bare name, without any folder prefix.
    for m in _FILE_RE.finditer(raw_all):
        add(m.group(1), 10, "file")
        for part in re.split(r"[-_.]", m.group(1).lower()):
            fragments.add(part)

    # Phrases: built-ins plus the wiki vocabulary.
    phrases = [p for p in dict.fromkeys([*BUILTIN_PHRASES, *(sanitize_term(v) for v in vocabulary)]) if len(p) > 2]
    # A one-word phrase is already scored as a phrase — don't count it again as a word.
    phrase_words = {p for p in phrases if " " not in p}
    for text, w in sources:
        hay = normalize_text(re.sub(r"[-_]", " ", text))
        if not hay:
            continue
        for p in phrases:
            n = _count_occurrences(hay, p)
            if n:
                add(p, n * w * (2 if " " in p else 1.5), "phrase")
        # Plain words, weighted by source.
        for word in hay.split(" "):
            if (
                len(word) < 3
                or word in STOPWORDS
                or word in phrase_words
                or word in fragments
                or re.fullmatch(r"[0-9.]+", word)
            ):
                continue
            # "rc.cfm" and similar: a word carrying a dot is a file fragment.
            if "." in word:
                continue
            add(word, w * 0.5, "word")

    # The account name can be the only pointer to the school's folder.
    for word in normalize_text(brief.get("account") or "").split(" "):
        if len(word) > 3 and word not in STOPWORDS:
            add(word, 1, "word")

    all_terms = [
        {"term": term, "weight": js_round1(v["weight"]), "kind": v["kind"]} for term, v in scores.items()
    ]
    all_terms.sort(key=lambda t: (-t["weight"], locale_key(t["term"])))
    # A word that's already part of a kept phrase adds nothing but noise.
    kept = [
        t for t in all_terms
        if t["kind"] != "word"
        or not any(
            o["kind"] == "phrase" and " " in o["term"] and t["term"] in o["term"].split(" ") and o["weight"] >= t["weight"]
            for o in all_terms
        )
    ]
    return kept[:MAX_TERMS]
