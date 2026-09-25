import asyncio

from creatio_case_lookup.wiki_select import (
    MAX_PAGE_CHARS,
    clip_wiki_pages,
    rescore_by_content,
    score_by_path,
    select_wiki_pages,
)

TREE = [
    {"path": "/Training Resources", "section": True},
    {"path": "/Training Resources/Report Card Variables", "section": False},
    {"path": "/Training Resources/Custom Transcripts", "section": True},
    {"path": "/Training Resources/Custom Transcripts/GPA Calculator", "section": False},
    {"path": "/Policies and Procedures/Report Card Testing Email", "section": False},
    {"path": "/Training Resources/Integrations/Canvas/Canvas Sync Errors", "section": False},
]

TERMS = [
    {"term": "gpa", "weight": 6, "kind": "phrase"},
    {"term": "transcript", "weight": 4, "kind": "phrase"},
]


def test_stage1_ranks_leaf_titles_above_sections_and_ignores_unrelated_pages():
    r = score_by_path(TREE, TERMS)
    assert r[0]["path"] == "/Training Resources/Custom Transcripts/GPA Calculator"
    assert not any("Canvas" in p["path"] for p in r)


def test_stage2_drops_empty_folder_pages_and_keeps_content_matches():
    c = score_by_path(TREE, TERMS)
    contents = {
        "/Training Resources/Custom Transcripts/GPA Calculator": "How the GPA is computed for a transcript. gpa gpa weighting rules and more text here.",
        "/Training Resources/Custom Transcripts": "",
    }
    r = rescore_by_content(c, contents, TERMS)
    assert r[0]["path"] == "/Training Resources/Custom Transcripts/GPA Calculator"
    assert not any(p["path"] == "/Training Resources/Custom Transcripts" for p in r)


def test_nothing_is_returned_when_no_title_matches():
    async def fetch(_p):
        raise AssertionError("should not fetch")

    sel = asyncio.run(select_wiki_pages(TREE, [{"term": "cafeteria", "weight": 9, "kind": "word"}], fetch, 4))
    assert sel["pages"] == []
    assert sel["skipped"]


def test_page_fetch_failures_are_tolerated():
    async def fetch(p):
        if "GPA" in p:
            return {"path": p, "url": "u", "content": "GPA and transcript details. " * 5}
        raise RuntimeError("boom")

    sel = asyncio.run(select_wiki_pages(TREE, TERMS, fetch, 4))
    assert [p["path"] for p in sel["pages"]] == ["/Training Resources/Custom Transcripts/GPA Calculator"]


def test_clipping_bounds_each_page_and_the_total():
    big = {"content": "x" * 50_000}
    out = clip_wiki_pages([big, big, big, big, big])
    assert len(out[0]["content"]) <= MAX_PAGE_CHARS + 30
    assert sum(len(p["content"]) for p in out) <= 20_000 + 100
