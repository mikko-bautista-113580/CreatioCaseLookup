import re

from creatio_case_lookup.case_files import enumerate_deep, include_targets, rank_case_files, with_case_files
from creatio_case_lookup.workspace import enumerate_workspaces


def fixture(tmp_path) -> str:
    root = tmp_path / "casefiles"
    root.mkdir()

    def w(rel: str, body: str) -> None:
        p = root.joinpath(*rel.split("/"))
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(body, encoding="utf-8")

    w("index.cfm", "<p>home</p>")
    w("EP-JAM/ReportCard.cfm", '<cfinclude template="inc/GetGrades.cfm">GPA shown here: #gpa#')
    w("EP-JAM/inc/GetGrades.cfm", "<cfquery>select grades</cfquery>")
    w("AA-CO/ReportCard.cfm", "unrelated school")
    w("EP-JAM/.env", "SECRET=1")
    w("node_modules/x/gpa.js", "gpa gpa gpa")
    w("a/b/c/d/e/f/deep.cfm", "gpa")
    return str(root)


TERMS = [
    {"term": "ep-jam", "weight": 10, "kind": "code"},
    {"term": "gpa", "weight": 4, "kind": "phrase"},
    {"term": "report card", "weight": 6, "kind": "phrase"},
]


def test_the_walk_is_recursive_but_skips_secrets_tooling_dirs_and_past_max_depth(tmp_path):
    deep = enumerate_deep([fixture(tmp_path)])
    rels = [f["rel"] for f in deep["files"]]
    assert "EP-JAM/ReportCard.cfm" in rels
    assert "EP-JAM/inc/GetGrades.cfm" in rels
    assert not any(r.endswith(".env") for r in rels)
    assert not any(r.startswith("node_modules") for r in rels)
    assert "a/b/c/d/e/f/deep.cfm" not in rels
    assert all("\\" not in r for r in rels)
    assert deep["truncated"] is True


def test_the_file_limit_holds(tmp_path):
    deep = enumerate_deep([fixture(tmp_path)], max_files=2)
    assert len(deep["files"]) == 2
    assert deep["truncated"] is True


def test_prefer_walks_named_folders_first(tmp_path):
    deep = enumerate_deep([fixture(tmp_path)], prefer=["ep-jam"])
    rels = [f["rel"] for f in deep["files"]]
    # Top-level files are listed while reading the root; the preferred folder is next.
    assert rels.index("EP-JAM/ReportCard.cfm") < rels.index("AA-CO/ReportCard.cfm")


def test_ranking_puts_the_schools_template_first_and_follows_its_include(tmp_path):
    root = fixture(tmp_path)
    ranked = rank_case_files(enumerate_deep([root])["files"], TERMS, 3)
    assert ranked[0]["rel"] == "EP-JAM/ReportCard.cfm"
    assert re.search(r"EP-JAM folder", ranked[0]["reason"])
    inc = next((r for r in ranked if r["rel"] == "EP-JAM/inc/GetGrades.cfm"), None)
    assert inc, "include was pulled in"
    assert len(ranked) <= 3


def test_include_targets_skips_dynamic_paths():
    assert include_targets(
        '<cfinclude template="a.cfm"><cfmodule template="#x#/b.cfm"><CFINCLUDE TEMPLATE=\'c.cfm\'>'
    ) == ["a.cfm", "c.cfm"]


def test_with_case_files_adds_valid_selected_subfolder_files_and_refuses_traversal(tmp_path):
    root = fixture(tmp_path)
    en = with_case_files(
        enumerate_workspaces([root]),
        [
            {"rel": "EP-JAM/ReportCard.cfm", "folder": root, "score": 1, "reason": ""},
            {"rel": "../outside.cfm", "folder": root, "score": 1, "reason": ""},
            {"rel": "EP-JAM/.env", "folder": root, "score": 1, "reason": ""},
            {"rel": "C:/Windows/win.ini", "folder": root, "score": 1, "reason": ""},
            {"rel": "EP-JAM/ReportCard.cfm", "folder": "C:\\elsewhere", "score": 1, "reason": ""},
        ],
        [root],
    )
    names = [f["name"] for f in en["files"]]
    assert "EP-JAM/ReportCard.cfm" in names
    assert "index.cfm" in names
    assert len([n for n in names if "/" in n]) == 1
