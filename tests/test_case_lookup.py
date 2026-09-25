"""case_lookup: rich-text helpers and the query recipes (no network).

The SEGMENT/STRIP/TRIM expectations were produced by the TypeScript build
(dist/caseLookup.js htmlToSegments/strip/trimReply) and hard-coded here, so the
Python port is held to identical output.
"""

import asyncio
from urllib.parse import quote

import pytest

from creatio_case_lookup import case_lookup as L
from creatio_case_lookup.case_lookup import (
    LINK_CLOSE,
    LINK_OPEN,
    LINK_SEP,
    html_to_segments,
    plain_mentions,
)


def text(html: str) -> str:
    return "\n".join(s["text"] if s["type"] == "text" else "" for s in html_to_segments(html))


# --- Ported from caseLookup.test.ts -----------------------------------------
def test_safelinks_wrapped_link_keeps_label_and_real_target():
    real = "https://smsd-ca.client.factsmgt.com/FTP/smsd-ca/custommockups/Grade%201.BlankReportCard%202.pdf"
    html = (
        f'<a href="https://nam12.safelinks.protection.outlook.com/?url={quote(real, safe="")}'
        '&amp;data=05%7C02&amp;reserved=0" '
        'style="color:blue">Grade 1.BlankReportCard 2.pdf</a><br />'
    )
    assert text(html) == LINK_OPEN + real + LINK_SEP + "Grade 1.BlankReportCard 2.pdf" + LINK_CLOSE
    assert plain_mentions(text(html)) == f"Grade 1.BlankReportCard 2.pdf <{real}>"


def test_mailto_link_flattens_to_bare_address():
    assert plain_mentions(text('<a href="mailto:a@b.com">a@b.com</a>')) == "a@b.com"


def test_unsafe_hrefs_are_dropped_label_kept():
    assert text('<a href="javascript:alert(1)">click</a>') == "click"
    assert text('<a href="/relative/path">rel</a>') == "rel"


# --- TS-generated parity cases ------------------------------------------------
SEGMENT_CASES = {
    "crlf": (
        "Line one\r\nLine two\r\n\r\n\r\n\r\nLine three  \t x<li>loose item</li>",
        [{"text": "Line one\nLine two\n\nLine three x\nloose item", "type": "text"}],
    ),
    "images": (
        '<p>See</p><img '
        'src="https://x.creatio.com/0/rest/FileService/Download/CaseFile/0123abcd-0123-4567-89ab-0123456789ab" '
        '/><img src="cid:foo"><img src="data:image/png;base64,AAAA"><img '
        'src="/0/rest/FileService/Download/SysImage/0123abcd-0123-4567-89ab-0123456789ab">end',
        [
            {"text": "See", "type": "text"},
            {"entity": "CaseFile", "id": "0123abcd-0123-4567-89ab-0123456789ab", "type": "image"},
            {"dataUri": "data:image/png;base64,AAAA", "type": "image"},
            {"text": "end", "type": "text"},
        ],
    ),
    "links": (
        '<a href="https://example.com/a?b=1&amp;c=2"><b>Docs</b> page</a> and <a '
        'href="mailto:x@y.com">x@y.com</a> and <a href="ftp://h/f">ftp</a>',
        [
            {
                "text": "https://example.com/a?b=1&c=2Docs page and "
                "mailto:x@y.comx@y.com and ftp",
                "type": "text",
            }
        ],
    ),
    "list": (
        "<p>Please:</p><ol>\n <li>First  item</li>\n <li>Second<br>line</li></ol><ul><li>bullet</li></ul>after",
        [
            {"text": "Please:", "type": "text"},
            {"items": ["First item", "Second\nline"], "ordered": True, "type": "list"},
            {"items": ["bullet"], "ordered": False, "type": "list"},
            {"text": "after", "type": "text"},
        ],
    ),
    "mention": (
        '<p><a data-mention-display-value="Nolan Kelliher" href="#"><span>N</span>Nolan Kelliher</a> '
        "please check</p><!-- c --><style>p{}</style>",
        [{"text": "Nolan Kelliher please check", "type": "text"}],
    ),
    "paragraphs": (
        "<div>\n\t\tHello&nbsp;&nbsp;world</div>\n"
        "<p>Second &amp; third &lt;tag&gt; &rsquo;quoted&rdquo;</p><br/>tail​ text",
        [{"text": "Hello world\n\nSecond & third <tag> 'quoted\"\n\ntail text", "type": "text"}],
    ),
}

STRIP_CASES = [
    (
        '<style>.a{}</style><p>Hi&nbsp;<a data-mention-display-value="Jane Doe">J</a>, it&#39;s &quot;done&quot; '
        "&mdash; ok &amp; v:* .shape</p>\n\n  end",
        "Hi @Jane Doe, it's \"done\" - ok & end",
    ),
    (None, ""),
    ("﻿  spaced \xa0 out ﻿", "spaced out"),
]

TRIM_CASES = [
    ("Thanks!\nFrom: Bob", "Thanks!"),
    ("Reply here On Mon, Jan 1, 2024 Bob wrote: old", "Reply here"),
    ("Hi Caution: This Message is From an External Sender blah", "Hi"),
]


@pytest.mark.parametrize("name", sorted(SEGMENT_CASES))
def test_html_to_segments_matches_ts(name):
    html, expected = SEGMENT_CASES[name]
    assert html_to_segments(html) == expected


@pytest.mark.parametrize("raw,expected", STRIP_CASES)
def test_strip_matches_ts(raw, expected):
    assert L.strip(raw) == expected


@pytest.mark.parametrize("raw,expected", TRIM_CASES)
def test_trim_reply_matches_ts(raw, expected):
    assert L.trim_reply(raw) == expected


def test_plain_mentions_matches_ts():
    s = (
        "Jane see https://a.comhttps://a.com and "
        "https://b.com/xLabel mailto:q@r.com"
    )
    assert plain_mentions(s) == "@Jane see https://a.com and Label <https://b.com/x> q@r.com"


def test_extract_file_images_dedupes_and_filters():
    g = "0123abcd-0123-4567-89ab-0123456789ab"
    html = (
        f'<img src="/0/rest/FileService/Download/ActivityFile/{g}">'
        f'<IMG SRC="/0/rest/FileService/Download/ActivityFile/{g}">'
        f'<img src="/0/rest/FileService/Download/SysImage/{g}"><img src="cid:x">'
    )
    assert L.extract_file_images(html) == [{"entity": "ActivityFile", "id": g}]
    assert L.extract_file_images(None) == []


def test_empty_inputs():
    assert html_to_segments(None) == []
    assert html_to_segments("") == []
    assert L.strip(None) == ""


# --- query recipes (query_records / odata_get faked) ----------------------------
class Fake:
    def __init__(self):
        self.calls = []
        self.responses = {}
        self.odata = {}
        self.odata_calls = []

    async def query_records(self, entity, opts=None, **kw):
        o = {**(opts or {}), **kw}
        self.calls.append((entity, o))
        r = self.responses.get(entity, [])
        if isinstance(r, Exception):
            raise r
        return r(o) if callable(r) else r

    async def odata_get(self, path):
        self.odata_calls.append(path)
        return self.odata


@pytest.fixture
def fake(monkeypatch):
    f = Fake()
    monkeypatch.setattr(L, "query_records", f.query_records)
    monkeypatch.setattr(L, "odata_get", f.odata_get)
    monkeypatch.setattr(L, "MAX_TOP", 50)
    return f


def test_find_cases_owner_uses_navigation_paths_and_status(fake):
    fake.responses["Case"] = [
        {
            "Id": "1",
            "Number": "SR1",
            "Subject": "s",
            "CreatedOn": "2024-01-01T00:00:00Z",
            "Status": {"Name": "New"},
            "Owner": None,
            "Account": {"Name": "Acme"},
        }
    ]
    out = asyncio.run(
        L.find_cases(mode="owner", guids=["g1", "", "g2"], statuses=["New", "Bogus", "Closed"])
    )
    entity, o = fake.calls[0]
    assert entity == "Case"
    assert o["filter"] == (
        "(Owner/Id eq g1 or Owner/Id eq g2) and (Status/Name eq 'New' or Status/Name eq 'Closed')"
    )
    assert o["expand"] == L.CASE_EXPAND and o["select"] == L.CASE_SELECT
    assert o["orderby"] == "CreatedOn desc" and o["top"] == 50
    assert out == {
        "cases": [
            {
                "Id": "1",
                "Number": "SR1",
                "Subject": "s",
                "CreatedOn": "2024-01-01T00:00:00Z",
                "Status": "New",
                "Owner": "",
                "Account": "Acme",
                "Contact": "",
            }
        ],
        "truncated": False,
        "caveats": [],
    }


def test_find_cases_modes(fake):
    asyncio.run(
        L.find_cases(
            {"mode": "account", "guids": ["a"], "statuses": L.OPEN_ACTIVE, "before": "2024-05-01T00:00:00Z"}
        )
    )
    assert fake.calls[-1][1]["filter"] == (
        "(Account/Id eq a) and (Status/Name eq 'New' or Status/Name eq 'In progress' or "
        "Status/Name eq 'Waiting for response' or Status/Name eq 'Resolved') and CreatedOn lt 2024-05-01T00:00:00Z"
    )
    # Number lookups ignore the status filter and escape quotes.
    asyncio.run(L.find_cases(mode="number", numbers=[" SR1 ", "", "O'x"], statuses=["New"]))
    assert fake.calls[-1][1]["filter"] == "(Number eq 'SR1' or Number eq 'O''x')"
    asyncio.run(L.find_cases(mode="recent"))
    assert fake.calls[-1][1]["filter"] is None
    for mode, msg in (
        ("owner", "No owner selected."),
        ("account", "No account selected."),
        ("number", "No case number provided."),
    ):
        with pytest.raises(Exception, match=msg):
            asyncio.run(L.find_cases(mode=mode))


def test_find_cases_truncation_caveat(fake):
    fake.responses["Case"] = [{"Id": str(i)} for i in range(50)]
    out = asyncio.run(L.find_cases(mode="recent"))
    assert out["truncated"] is True
    assert out["caveats"] == [
        'Result hit the 50-row cap — there may be more. Use "load older" to page further back.'
    ]


def test_resolvers(fake):
    fake.responses["Contact"] = [{"Id": "1", "Name": "A", "Email": "x"}]
    assert asyncio.run(L.resolve_owner("O'Neil")) == [{"Id": "1", "Name": "A"}]
    assert fake.calls[-1] == (
        "Contact",
        {"filter": "contains(Name,'O''Neil')", "select": ["Id", "Name"], "orderby": "Name", "top": 50},
    )
    asyncio.run(L.resolve_account("Acme"))
    assert fake.calls[-1][0] == "Account"


def test_timeline_merges_feed_and_email_stable_by_date(fake):
    fake.responses["SocialMessage"] = [
        {"Id": "f1", "Message": "<p>first</p>", "CreatedOn": "2024-01-01T10:00:00Z", "CreatedById": "C1"},
        {
            "Id": "f2",
            "Message": "same time feed",
            "CreatedOn": "2024-01-01T12:00:00Z",
            "CreatedById": "00000000-0000-0000-0000-000000000000",
        },
    ]
    fake.responses["Activity"] = [
        {
            "Id": "m1",
            "Title": "Re: SR1",
            "CreatedOn": "2024-01-01T12:00:00.000Z",
            "Sender": "Bob <BOB@x.com>",
            "Recepient": "me@x.com",
            "Body": "hello<br>From: old",
        },
        {
            "Id": "m2",
            "Title": "SR1",
            "CreatedOn": "2024-01-01T09:00:00Z",
            "Sender": "ghost@x.com",
            "Recepient": None,
            "Body": None,
        },
    ]

    def contacts(o):
        if o["filter"].startswith("Id eq"):
            return [{"Id": "c1", "Name": "Carol"}]
        return [{"Email": "bob@x.com", "Name": "Bob B"}]

    fake.responses["Contact"] = contacts
    tl = asyncio.run(L.get_timeline("case-guid", "SR1"))
    assert [(e["kind"], e["ts"]) for e in tl] == [
        ("EMAIL", "2024-01-01T09:00:00Z"),
        ("FEED", "2024-01-01T10:00:00Z"),
        ("FEED", "2024-01-01T12:00:00Z"),  # stable: feed before the same-instant email
        ("EMAIL", "2024-01-01T12:00:00.000Z"),
    ]
    assert tl[1]["author"] == "Carol" and tl[1]["authorId"] == "C1"
    assert tl[1]["segments"] == [{"type": "text", "text": "first"}]
    assert "author" not in tl[2]
    assert tl[3] == {
        "kind": "EMAIL",
        "ts": "2024-01-01T12:00:00.000Z",
        "title": "Re: SR1",
        "sender": "Bob <BOB@x.com>",
        "recipient": "me@x.com",
        "author": "Bob B",
        "text": "hello",
        "images": [],
    }
    assert tl[0]["author"] == "ghost@x.com" and tl[0]["recipient"] is None
    q_feed, q_mail = fake.calls[0], fake.calls[1]
    assert q_feed[1]["filter"] == "EntityId eq case-guid"
    assert q_mail[1]["select"] == ["Id", "Title", "CreatedOn", "Sender", "Recepient", "SendDate", "Body"]
    assert q_mail[1]["filter"] == "contains(Title,'SR1')"
    # Only C1 was looked up (the empty GUID is skipped); email addresses deduped.
    assert fake.calls[2][1]["filter"] == "Id eq C1"
    assert fake.calls[3][1]["filter"] == "Email eq 'bob@x.com' or Email eq 'ghost@x.com'"


def test_contact_lookups_batch_by_20_and_tolerate_failures(fake):
    fake.responses["SocialMessage"] = [
        {"Id": str(i), "Message": "", "CreatedOn": "2024-01-01T00:00:00Z", "CreatedById": f"id{i}"}
        for i in range(45)
    ]
    fake.responses["Contact"] = RuntimeError("Contact not allowlisted")
    tl = asyncio.run(L.get_timeline("c", "SR1"))
    contact_calls = [o for e, o in fake.calls if e == "Contact"]
    assert [o["top"] for o in contact_calls] == [20, 20, 5]
    assert len(tl) == 45 and all("author" not in e for e in tl)


def test_attachments_extra_and_case_info(fake):
    fake.responses["CaseFile"] = [{"Id": "f", "Name": None, "Size": "12", "CreatedOn": None}]
    assert asyncio.run(L.get_attachments("c")) == [{"id": "f", "name": "", "size": 12, "createdOn": ""}]
    assert fake.calls[-1][1] == {
        "select": ["Id", "Name", "Size", "CreatedOn"],
        "filter": "Case/Id eq c",
        "orderby": "CreatedOn desc",
        "top": 25,
    }

    fake.odata = {"RegisteredOn": "r", "SolutionOverdue": False, "NltHoursWorked": 1.5}
    assert asyncio.run(L.get_extra_fields("c")) == {
        "RegisteredOn": "r",
        "SolutionOverdue": False,
        "NltHoursWorked": 1.5,
    }

    fake.odata = {
        "Contact": {"Name": "Ann"},
        "Account": {"Name": "Acme", "NltDistrictCode": 7},
        "SolutionDate": None,
    }
    info = asyncio.run(L.get_case_info("c"))
    assert fake.odata_calls[-1] == f"Case(c)?{L.CASE_INFO_QUERY}"
    assert info[0] == {"label": "Contact", "value": "Ann", "link": True}
    assert info[1] == {"label": "Account", "value": "Acme", "link": True, "required": True}
    assert info[7] == {"label": "Resolution time", "value": "", "date": True}
    assert info[8] == {"label": "SIS District code", "value": "7"}
    assert [f["label"] for f in info] == [
        "Contact",
        "Account",
        "Priority",
        "Category",
        "Service",
        "Service Area",
        "Case Type",
        "Resolution time",
        "SIS District code",
        "School Code",
        "Institution ID Number",
    ]


def test_get_case_detail(fake):
    fake.odata = {"Symptoms": "<p>Broken&nbsp;report</p>"}
    fake.responses["CaseFile"] = RuntimeError('Entity "CaseFile" is not in the allowlist')
    row = {"Id": "c", "Number": "SR1"}
    out = asyncio.run(L.get_case_detail(row, ["summary", "description", "latest", "attachments"]))
    assert out == {
        "description": "Broken report",
        "descriptionSegments": [{"type": "text", "text": "Broken report"}],
        "latest": None,
        "attachmentsError": 'Entity "CaseFile" is not in the allowlist',
    }
    assert asyncio.run(L.get_case_detail(row, ["summary"])) == {}
