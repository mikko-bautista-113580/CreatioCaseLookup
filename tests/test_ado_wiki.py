import asyncio
import json
import time

import pytest

from creatio_case_lookup import ado_wiki
from creatio_case_lookup.ado_wiki import (
    WikiUnavailable,
    clean_page_content,
    flatten_tree,
    get_token,
    page_url,
    parse_token_output,
    set_az_runner,
)


@pytest.fixture(autouse=True)
def _reset_runner():
    yield
    set_az_runner(None)


def test_token_output_parses_both_expiry_formats():
    a = parse_token_output(json.dumps({"accessToken": "t1", "expires_on": 2_000_000_000}))
    assert a["token"] == "t1"
    assert a["expires"] == 2_000_000_000_000
    b = parse_token_output(json.dumps({"accessToken": "t2", "expiresOn": "2030-01-01 10:00:00.000000"}))
    assert b["token"] == "t2"
    assert b["expires"] > time.time() * 1000


def test_bad_token_output_is_not_logged_in():
    with pytest.raises(WikiUnavailable) as e:
        parse_token_output("nope")
    assert e.value.reason == "not-logged-in"
    with pytest.raises(WikiUnavailable):
        parse_token_output(json.dumps({"accessToken": ""}))


def test_the_token_is_cached_until_near_expiry():
    calls = 0

    async def runner(_args):
        nonlocal calls
        calls += 1
        return {"code": 0, "stdout": json.dumps({"accessToken": "tok", "expires_on": int(time.time()) + 3600}), "stderr": ""}

    set_az_runner(runner)

    async def go():
        assert await get_token() == "tok"
        assert await get_token() == "tok"

    asyncio.run(go())
    assert calls == 1


def test_a_missing_az_becomes_wiki_unavailable_az_missing():
    async def runner(_args):
        return {"code": 127, "stdout": "", "stderr": "spawn az ENOENT"}

    set_az_runner(runner)
    with pytest.raises(WikiUnavailable) as e:
        asyncio.run(get_token())
    assert e.value.reason == "az-missing"


def test_a_logged_out_az_becomes_wiki_unavailable_not_logged_in():
    async def runner(_args):
        return {"code": 1, "stdout": "", "stderr": "Please run 'az login' to setup account."}

    set_az_runner(runner)
    with pytest.raises(WikiUnavailable) as e:
        asyncio.run(get_token())
    assert e.value.reason == "not-logged-in"


def test_the_default_runner_refuses_shell_metacharacters():
    r = asyncio.run(ado_wiki._default_az_runner(["account", "x & calc"]))
    assert r["code"] == 2


def test_the_tree_flattens_without_the_root_or_image_folders():
    pages = flatten_tree({
        "path": "/",
        "subPages": [
            {"path": "/A", "id": 1, "subPages": [{"path": "/A/B", "id": 2}, {"path": "/A/.images"}]},
            {"path": "/C", "id": 3},
        ],
    })
    assert pages == [
        {"path": "/A", "id": 1, "section": True},
        {"path": "/A/B", "id": 2, "section": False},
        {"path": "/C", "id": 3, "section": False},
    ]


def test_image_embeds_are_stripped_from_page_content():
    assert clean_page_content("Hi ![x](/.images/a.png) <img src=x> [link](u)") == "Hi   [link](u)"


def test_page_url_encodes_like_encode_uri_component():
    c = {"org": "renweb", "project": "Custom Development", "wiki": "Custom-Team.wiki"}
    assert page_url(c, "/A B/C", 7) == "https://dev.azure.com/renweb/Custom%20Development/_wiki/wikis/Custom-Team.wiki/7"
    assert page_url(c, "/A B/C").endswith("?pagePath=%2FA%20B%2FC")


def test_cached_tree_is_reused_without_az(tmp_path, monkeypatch):
    monkeypatch.setattr(ado_wiki, "TREE_PATH", tmp_path / "tree.json")
    monkeypatch.setattr(ado_wiki, "wiki_config", lambda: {
        "org": "o", "project": "p", "wiki": "w", "enabled": True, "maxPages": 4,
    })
    from creatio_case_lookup.workspace import iso_now

    (tmp_path / "tree.json").write_text(
        json.dumps({"fetchedAt": iso_now(), "wiki": "o/p/w", "pages": [{"path": "/X", "section": False}]}),
        encoding="utf-8",
    )

    async def runner(_args):
        raise AssertionError("az must not run")

    set_az_runner(runner)
    assert asyncio.run(ado_wiki.get_wiki_tree()) == [{"path": "/X", "section": False}]
