import asyncio
import json

import pytest

from creatio_case_lookup import ado_skills, ado_wiki
from creatio_case_lookup.ado_skills import (
    SkillsUnavailable,
    get_skill,
    group_skills,
    list_skills,
    parse_front_matter,
    select_skills,
    skills_config,
)

CFG = {"org": "renweb", "project": "Custom Development", "repo": "Custom-Team", "path": "/Skills", "branch": "",
       "enabled": True, "maxFull": 4}

ITEMS = {"count": 7, "value": [
    {"path": "/Skills", "isFolder": True},
    {"path": "/Skills/README.md"},
    {"path": "/Skills/facts-sis-reports", "isFolder": True},
    {"path": "/Skills/facts-sis-reports/SKILL.md"},
    {"path": "/Skills/facts-sis-reports/refs/vars.md"},
    {"path": "/Skills/external-api-user-story/skill.md"},
    {"path": "/Skills/no-skill-md/notes.txt"},
    {"path": "/Skills/.hidden/SKILL.md"},
]}


@pytest.fixture(autouse=True)
def isolate(monkeypatch, tmp_path):
    monkeypatch.setattr(ado_skills, "TREE_PATH", tmp_path / "skills" / "tree.json")
    monkeypatch.setattr(ado_skills, "PAGES_DIR", tmp_path / "skills" / "pages")
    monkeypatch.setattr(ado_skills, "skills_config", lambda: dict(CFG))
    yield
    ado_wiki.set_az_runner(None)


def fake_get(monkeypatch, responses):
    calls = []

    async def get(url, label="team wiki"):
        calls.append((url, label))
        for k, v in responses.items():
            if k in url:
                if isinstance(v, Exception):
                    raise v
                return {"json": v, "etag": ""}
        raise AssertionError(url)

    monkeypatch.setattr(ado_wiki, "_ado_get", get)
    return calls


def test_config_defaults_from_wiki(monkeypatch):
    monkeypatch.undo()  # the real skills_config
    monkeypatch.setattr(ado_skills, "read_env_file", lambda: {"ADO_SKILLS_PATH": "Skills/", "CREATIO_SKILLS_MAX_FULL": "99"})
    monkeypatch.setattr(ado_wiki, "read_env_file", lambda: {"ADO_WIKI_ORG": "acme"})
    c = skills_config()
    assert c == {"org": "acme", "project": "Custom Development", "repo": "Custom-Team", "path": "/Skills",
                 "branch": "", "enabled": True, "maxFull": 10}
    monkeypatch.setattr(ado_skills, "read_env_file", lambda: {"CREATIO_SKILLS_ENABLED": "off"})
    assert skills_config()["enabled"] is False


def test_group_skills():
    s = group_skills(ITEMS, "/Skills", CFG)
    assert [x["name"] for x in s] == ["external-api-user-story", "facts-sis-reports"]
    assert s[1]["skillMdPath"] == "/Skills/facts-sis-reports/SKILL.md"
    assert s[1]["files"] == ["refs/vars.md"]
    assert s[1]["url"] == ("https://dev.azure.com/renweb/Custom%20Development/_git/Custom-Team"
                           "?path=%2FSkills%2Ffacts-sis-reports%2FSKILL.md")
    assert "&version=GBdev" in group_skills(ITEMS, "/Skills", {**CFG, "branch": "dev"})[0]["url"]


def test_parse_front_matter():
    md = "﻿---\nname: facts-sis-reports\ndescription: >\n  Expert guidance for\n  FACTS reports.\nother: x\n---\n# Body\n"
    assert parse_front_matter(md) == {"name": "facts-sis-reports", "description": "Expert guidance for FACTS reports.",
                                      "body": "# Body\n"}
    assert parse_front_matter('---\r\nname: "q"\r\ndescription: \'one line\'\r\n---\r\nb') == {
        "name": "q", "description": "one line", "body": "b"}
    assert parse_front_matter("no front matter") == {"body": "no front matter"}


def test_list_and_get_skill_are_cached(monkeypatch):
    calls = fake_get(monkeypatch, {
        "scopePath=": ITEMS,
        "SKILL.md&includeContent": {"content": "---\nname: facts-sis-reports\ndescription: Reports\n---\nUse X."},
    })
    skills = asyncio.run(list_skills())
    assert len(skills) == 2 and calls[0][1] == "team skills repo"
    assert "recursionLevel=Full" in calls[0][0] and "%2FSkills" in calls[0][0]
    s = asyncio.run(get_skill(skills[1]))
    assert s["name"] == "facts-sis-reports" and s["description"] == "Reports" and s["files"] == ["refs/vars.md"]
    assert "%24format=json" in calls[1][0]
    n = len(calls)
    assert asyncio.run(list_skills()) == skills
    assert asyncio.run(get_skill(skills[1])) == s
    assert len(calls) == n  # both served from cache
    doc = json.loads(ado_skills.TREE_PATH.read_text(encoding="utf-8"))
    assert doc["repo"] == "renweb/Custom Development/Custom-Team@(default):/Skills"


def test_not_logged_in_names_the_skills(monkeypatch):
    async def runner(args):
        return {"code": 1, "stdout": "", "stderr": "Please run az login"}

    ado_wiki.set_az_runner(runner)
    with pytest.raises(SkillsUnavailable) as ei:
        asyncio.run(list_skills())
    assert ei.value.reason == "not-logged-in" and "team skills were skipped" in str(ei.value)


def test_disabled(monkeypatch):
    monkeypatch.setattr(ado_skills, "skills_config", lambda: {**CFG, "enabled": False})
    with pytest.raises(SkillsUnavailable) as ei:
        asyncio.run(list_skills())
    assert ei.value.reason == "disabled"


def test_load_all_tolerates_one_failure(monkeypatch):
    fake_get(monkeypatch, {
        "scopePath=": ITEMS,
        "external-api-user-story": SkillsUnavailable("boom", "http"),
        "facts-sis-reports": {"content": "body"},
    })
    got = asyncio.run(ado_skills.load_all_skills())
    assert [(s["name"], s["content"]) for s in got] == [("external-api-user-story", ""), ("facts-sis-reports", "body")]


def test_skill_files_are_read_cached_and_budgeted(monkeypatch):
    calls = fake_get(monkeypatch, {
        "scopePath=": ITEMS,
        "refs%2Fvars.md": {"content": "x" * 50},
    })
    info = asyncio.run(list_skills())[1]
    assert asyncio.run(ado_skills.get_skill_file(info, "refs/vars.md")) == "x" * 50
    n = len(calls)
    assert asyncio.run(ado_skills.get_skill_file(info, "refs/vars.md")) == "x" * 50 and len(calls) == n
    assert "/Skills/facts-sis-reports/refs/vars.md" in calls[-1][0].replace("%2F", "/")
    with pytest.raises(SkillsUnavailable, match="not a file of"):
        asyncio.run(ado_skills.get_skill_file(info, "../../secrets.md"))

    monkeypatch.setattr(ado_skills, "MAX_ASSET_CHARS", 10)
    skills = [{**info, "full": True, "files": ["refs/vars.md", "logo.png"]}, {**info, "full": False}]
    out = asyncio.run(ado_skills.attach_skill_assets(skills))
    assert out[0]["assets"] == [{"path": "refs/vars.md", "content": "x" * 10 + "\n… [file clipped]"}]
    assert "assets" not in out[1]


def test_select_skills_ranks_and_budgets(monkeypatch):
    skills = [
        {"name": "external-api-user-story", "description": "ADO user stories for API endpoints", "content": "endpoint " * 5},
        {"name": "facts-sis-reports", "description": "Report card templates and GPA variables", "content": "gpa " * 20},
        {"name": "onsis-xml-validator", "description": "OnSIS XML", "content": "xml"},
    ]
    terms = [{"term": "report card", "weight": 2, "kind": "phrase"}, {"term": "gpa", "weight": 1, "kind": "word"}]
    out = select_skills(skills, terms, 4)
    assert [s["name"] for s in out][0] == "facts-sis-reports"
    assert [s["full"] for s in out] == [True, False, False]  # only matching skills get full text
    assert out[1]["content"] == "" and out[0]["why"].startswith("matches ")
    monkeypatch.setattr(ado_skills, "MAX_SKILL_CHARS", 10)
    assert select_skills(skills, terms, 4)[0]["content"] == "gpa gpa gp\n… [skill clipped]"
    assert all(not s["full"] for s in select_skills(skills, [], 4))
