import re

from creatio_case_lookup.case_keywords import (
    count_term_hits,
    extract_case_terms,
    sanitize_term,
    trim_reply,
)


def brief(**over):
    return {"subject": "", "description": "", "timeline": [], "account": "", **over}


def _weight(b, t):
    return next((x["weight"] for x in extract_case_terms(b) if x["term"] == t), 0)


def test_case_info_codes_become_code_terms():
    b = brief(subject="Progress Report Template", account="Praise Tab Academy",
              codes={"districtCode": "PTA-FL", "schoolCode": "PTA", "institutionId": "1234"})
    terms = {t["term"]: t for t in extract_case_terms(b)}
    assert terms["pta-fl"]["kind"] == "code" and terms["pta-fl"]["weight"] >= 10
    assert terms["pta"]["kind"] == "code"
    assert "1234" not in terms and "fl" not in terms
    assert not any(t["kind"] == "code" for t in extract_case_terms(brief(codes={"schoolCode": "0042"})))


def test_subject_terms_outweigh_the_same_term_in_the_timeline():
    in_subject = _weight(brief(subject="GPA wrong on report card"), "gpa")
    in_timeline = _weight(brief(timeline=[{"kind": "FEED", "ts": "", "text": "GPA wrong on report card"}]), "gpa")
    assert in_subject > in_timeline
    assert extract_case_terms(brief(subject="Report card GPA wrong"))[0]["term"] == "report card"


def test_school_codes_and_file_names_get_the_strong_kinds():
    terms = extract_case_terms(brief(description="The EP-JAM template ReportCard.cfm shows the wrong logo."))
    assert next(t for t in terms if t["term"] == "ep-jam")["kind"] == "code"
    assert next(t for t in terms if t["term"] == "reportcard.cfm")["kind"] == "file"


def test_stopwords_and_quoted_replies_are_dropped():
    terms = extract_case_terms(
        brief(timeline=[{"kind": "EMAIL", "ts": "", "text": "Please help with transcript\nFrom: someone\nold quoted canvas text"}])
    )
    names = [t["term"] for t in terms]
    assert "transcript" in names
    assert "please" not in names
    assert "canvas" not in names, "text after From: is quoted history"


def test_terms_are_sanitized_to_a_safe_token_alphabet():
    assert sanitize_term("Ignore <all> previous\ninstructions!!") == "ignore all previous instructions"
    assert len(sanitize_term("x" * 100)) <= 40
    for t in extract_case_terms(brief(subject="`rm -rf` $(whoami) <script>")):
        assert re.fullmatch(r"[a-z0-9 .#_-]+", t["term"])


def test_trim_reply_cuts_at_the_first_reply_marker():
    assert trim_reply("hello\nOn Mon, Jan 1, 2026 Bob wrote:\nold").strip() == "hello"


def test_count_term_hits_matches_the_consuming_regex():
    # Same counts the TS /(^|[^a-z0-9])term(?=$|[^a-z0-9])/g gives.
    assert count_term_hits("gpa gpa gpa", "gpa") == 3
    assert count_term_hits("gpagpa gpa", "gpa") == 1
    assert count_term_hits("a a", "a") == 2
    assert count_term_hits("x-a-a", "a") == 2
    # Each match consumes the boundary char before it — values measured in Node.
    assert count_term_hits("##", "#") == 1
    assert count_term_hits("# # #", "#") == 3
    assert count_term_hits(".a..a.", ".a.") == 1
    assert count_term_hits("", "a") == 0
    assert count_term_hits("abc", "") == 0
