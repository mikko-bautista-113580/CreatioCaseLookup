import json
import os
import re
import sys

import pytest

from creatio_case_lookup import workspace as ws
from creatio_case_lookup.workspace import (
    WorkspacePathError,
    WorkspaceWriteError,
    enumerate_workspace,
    iso_from_timestamp,
    iso_now,
    locale_key,
    safe_asset_name,
    sniff_image_type,
    slug_for_file,
    slug_for_path,
    slug_for_paths,
    validate_workspace_path,
)

win_only = pytest.mark.skipif(sys.platform != "win32", reason="slugs lowercase the key on Windows only")


# Expected values produced by the compiled TS (dist/workspace.js) on Windows.
@win_only
def test_slugs_match_the_typescript_build():
    assert slug_for_path("C:\\neldevsrc\\Github\\MyProject") == "c-neldevsrc-github-myproject-1c3407a8"
    assert slug_for_path("C:\\neldevsrc\\Github\\MyProject\\") == "c-neldevsrc-github-myproject-1c3407a8"
    assert slug_for_path("c:\\NELDEVSRC\\github\\myproject") == "c-neldevsrc-github-myproject-1c3407a8"
    assert slug_for_paths(["C:\\a\\b", "C:\\c"]) == "c-a-b-plus1-af00cb0c"
    assert slug_for_paths(["C:\\neldevsrc\\ColdfusionReports\\ReportCardAO"]) == "c-neldevsrc-coldfusionreports-reportcardao-2b213703"


def test_slug_for_file_matches_the_typescript_build():
    assert slug_for_file("EP-JAM/ReportCard.cfm") == "ep-jam-reportcard-cfm"
    assert slug_for_file("x" * 90 + ".cfm") == "x" * 70 + "-7132abea"
    assert slug_for_file("!!!") == "file"


def test_iso_helpers_use_the_js_format():
    assert re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z", iso_now())
    assert iso_from_timestamp(0) == "1970-01-01T00:00:00.000Z"
    assert iso_from_timestamp(1790041633.5417) == "2026-09-22T01:47:13.541Z"


def test_locale_key_orders_like_locale_compare():
    # Order measured with Node's String#localeCompare.
    items = ["a", "A", "b", "B", "ab", "Ab", "a-b", "a_b", "a b", "a.b", "a1", "a#",
             "EP-JAM/x.cfm", "ep-jam/X.cfm", "index.cfm", "Index.cfm"]
    expect = "a|A|a b|a_b|a-b|a.b|a#|a1|ab|Ab|b|B|ep-jam/X.cfm|EP-JAM/x.cfm|index.cfm|Index.cfm".split("|")
    assert sorted(items, key=locale_key) == expect


# ---------------------------------------------------------------------------
# Path validation
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "raw, msg",
    [
        ("", "Enter the folder"),
        ('C:\\a"b', "can't be stored in .env"),
        ("C:\\a=b", "can't be stored in .env"),
    ],
)
def test_validation_refuses_bad_input(raw, msg):
    with pytest.raises(WorkspacePathError, match=re.escape(msg)):
        validate_workspace_path(raw)


@win_only
@pytest.mark.parametrize(
    "raw, msg",
    [
        ("\\\\server\\share", "drive letter"),
        ("relative\\path", "drive letter"),
        ("C:\\", "drive root"),
        ("C:\\Windows\\System32", "system folder"),
        ("C:\\Program Files", "system folder"),
        ("C:\\x\\node_modules\\y", 'goes through "node_modules"'),
    ],
)
def test_validation_refuses_roots_system_trees_and_tooling(raw, msg):
    with pytest.raises(WorkspacePathError, match=re.escape(msg)):
        validate_workspace_path(raw)


def test_validation_refuses_home_missing_and_files(tmp_path, monkeypatch):
    monkeypatch.setenv("USERPROFILE", str(tmp_path))
    monkeypatch.setenv("HOME", str(tmp_path))
    with pytest.raises(WorkspacePathError, match="too broad"):
        validate_workspace_path(str(tmp_path))
    with pytest.raises(WorkspacePathError, match="too broad"):
        validate_workspace_path(str(tmp_path / "Downloads"))
    with pytest.raises(WorkspacePathError, match="doesn't exist"):
        validate_workspace_path(str(tmp_path / "nope"))
    f = tmp_path / "proj" / "a.txt"
    f.parent.mkdir()
    f.write_text("x", encoding="utf-8")
    with pytest.raises(WorkspacePathError, match="That's a file"):
        validate_workspace_path(str(f))
    # A real project folder passes, trailing separator stripped.
    assert validate_workspace_path(str(tmp_path / "proj") + os.sep) == str(tmp_path / "proj")


# ---------------------------------------------------------------------------
# Enumeration
# ---------------------------------------------------------------------------


def test_enumeration_is_single_level_and_skips_secrets_and_binaries(tmp_path, monkeypatch):
    monkeypatch.setattr(ws, "file_cap", lambda: 2)
    for name, body in [
        ("b.cfm", b"x"), ("A.htm", b"x"), ("README", b"x"), (".env", b"S=1"), (".env.local", b"S=1"),
        ("server.pem", b"k"), ("id_rsa", b"k"), ("logo.png", b"\x89PNG"), ("big.sql", b"x" * (ws.MAX_FILE_BYTES + 1)),
    ]:
        (tmp_path / name).write_bytes(body)
    (tmp_path / "sub").mkdir()
    (tmp_path / "sub" / "inner.cfm").write_text("x", encoding="utf-8")
    (tmp_path / "node_modules").mkdir()

    r = enumerate_workspace(str(tmp_path))
    assert [f["name"] for f in r["files"]] == ["A.htm", "b.cfm", "README"]
    assert r["dirs"] == ["sub"]
    assert r["skipped"] == {"binaries": 1, "oversized": 1, "secrets": 4, "unreadable": 0, "entriesTruncated": False}
    assert r["count"] == 3 and r["cap"] == 2 and r["overCap"] is True
    f = r["files"][0]
    assert f["ext"] == ".htm" and f["size"] == 1
    assert re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z", f["mtime"])


def test_secret_re_and_text_files():
    assert ws.SECRET_RE.search(".env")
    assert ws.SECRET_RE.search(".ENV.production")
    assert ws.SECRET_RE.search("cert.PFX")
    assert not ws.SECRET_RE.search("environment.cfm")
    assert ws.is_text_file("Dockerfile") and ws.is_text_file("x.CFM")
    assert not ws.is_text_file("x.exe") and not ws.is_text_file("noext")


# ---------------------------------------------------------------------------
# Artifact store
# ---------------------------------------------------------------------------


@pytest.fixture
def store(tmp_path, monkeypatch):
    d = tmp_path / ".analysis"
    monkeypatch.setattr(ws, "ANALYSIS_DIR", d)
    monkeypatch.setattr(ws, "INDEX_PATH", d / "index.json")
    return d


def _meta(folder: str, mode="directory", target=None, **over):
    return {
        "version": 1,
        "slug": slug_for_paths([folder]),
        "path": folder,
        "paths": [folder],
        "mode": mode,
        "target": target,
        "startedAt": "2026-01-01T00:00:00.000Z",
        "finishedAt": "2026-01-01T00:01:00.000Z",
        "cap": 10,
        "capExceeded": False,
        "proceededOverCap": False,
        "filesAnalyzed": [{"name": "a.cfm", "size": 1, "mtime": "2025-01-01T00:00:00.000Z", "ext": ".cfm", "folder": folder}],
        "dirsPresent": [],
        "skipped": {"binaries": 0, "oversized": 0, "secrets": 0, "unreadable": 0, "entriesTruncated": False},
        "truncated": False,
        "toolCalls": [],
        "usage": {},
        "status": "complete",
        "report": "",
        **over,
    }


def test_save_and_load_round_trip(store):
    folder = "C:\\proj\\it's" if sys.platform == "win32" else "/proj/it's"
    meta = _meta(folder, model="claude-x")
    saved = ws.save_analysis(meta, "# Report\n\nbody\n\n\n")
    slug = meta["slug"]
    assert saved == {"report": f".analysis/{slug}/analysis.md", "meta": f".analysis/{slug}/analysis.json"}

    md = (store / slug / "analysis.md").read_text(encoding="utf-8")
    assert md.startswith("---\nworkspace: '" + folder.replace("'", "''") + "'\n")
    assert "\nmode: directory\ntarget: null\n" in md
    assert "\nfiles_analyzed: 1\ntruncated: false\nstatus: complete\n---\n# Report\n\nbody\n" in md
    assert md.endswith("body\n")

    loaded = ws.load_analysis(folder)
    assert loaded["meta"]["report"] == saved["report"]
    assert loaded["body"] == "# Report\n\nbody\n"
    assert ws.load_analysis_for([folder])["meta"]["slug"] == slug

    entry = ws.index_entry_for(folder)
    assert entry["directory"]["fileCount"] == 1 and entry["files"] == []
    assert ws.list_analyses()[0]["slug"] == slug
    assert ws.load_analysis(folder, "file", "missing.cfm") is None


def test_case_mode_goes_in_the_cases_list(store):
    folder = "C:\\proj" if sys.platform == "win32" else "/proj"
    ws.save_analysis(_meta(folder, mode="case", target="SR00064810"), "case report")
    ws.save_analysis(_meta(folder, mode="file", target="EP-JAM/RC.cfm"), "file report")
    entry = ws.index_entry_for([folder])
    assert [c["name"] for c in entry["cases"]] == ["SR00064810"]
    assert entry["cases"][0]["report"].endswith("/cases/SR00064810.md")
    assert [f["name"] for f in entry["files"]] == ["EP-JAM/RC.cfm"]
    assert entry["files"][0]["report"].endswith("/files/ep-jam-rc-cfm.md")
    assert ws.load_analysis(folder, "case", "SR00064810")["body"] == "case report\n"
    doc = json.loads((store / "index.json").read_text(encoding="utf-8"))
    assert doc["version"] == 1 and re.fullmatch(r".*Z", doc["updatedAt"])


def test_corrupt_index_is_moved_aside(store):
    store.mkdir(parents=True)
    (store / "index.json").write_text("{not json", encoding="utf-8")
    assert ws.list_analyses() == []
    assert any(p.name.startswith("index.corrupt-") for p in store.iterdir())


def test_is_stale():
    folder = "C:\\proj"
    meta = _meta(folder)
    same = {"files": [{"name": "a.cfm", "folder": folder, "mtime": "2025-06-01T00:00:00.000Z"}]}
    assert ws.is_stale(meta, same) is False
    newer = {"files": [{"name": "a.cfm", "folder": folder, "mtime": "2026-06-01T00:00:00.000Z"}]}
    assert ws.is_stale(meta, newer) is True
    added = {"files": same["files"] + [{"name": "b.cfm", "folder": folder, "mtime": "2025-01-01T00:00:00.000Z"}]}
    assert ws.is_stale(meta, added) is True
    assert ws.is_stale({**meta, "finishedAt": "garbage"}, same) is True


# ---------------------------------------------------------------------------
# Assets
# ---------------------------------------------------------------------------

PNG = b"\x89PNG\r\n\x1a\n" + b"\0" * 16


def test_sniff_image_type():
    assert sniff_image_type(PNG)["label"] == "PNG"
    assert sniff_image_type(b"\xff\xd8\xff\xe0")["ext"] == [".jpg", ".jpeg"]
    assert sniff_image_type(b"GIF89a")["label"] == "GIF"
    assert sniff_image_type(b"RIFF\0\0\0\0WEBP")["label"] == "WebP"
    assert sniff_image_type(b"BM")["label"] == "BMP"
    assert sniff_image_type(b"\0\0\x01\0")["label"] == "icon"
    assert sniff_image_type(b"GIF") is None
    assert sniff_image_type(b"<cfoutput>") is None
    assert sniff_image_type(b"") is None


def test_safe_asset_name():
    assert safe_asset_name("C:\\x\\..\\my logo!.PNG") == "my logo_.PNG"
    with pytest.raises(WorkspaceWriteError) as e:
        safe_asset_name("evil.cfm")
    assert e.value.code == "ext"
    with pytest.raises(WorkspaceWriteError) as e:
        safe_asset_name("a/..")
    assert e.value.code == "name"


def test_save_asset_to_workspace(store, tmp_path):
    folder = tmp_path / "proj"
    folder.mkdir()
    allowed = [str(folder)]
    r = ws.save_asset_to_workspace(str(folder), "logo.png", PNG, allowed=allowed)
    assert r == {"path": str(folder / "logo.png"), "name": "logo.png", "overwrote": False}
    with pytest.raises(WorkspaceWriteError) as e:
        ws.save_asset_to_workspace(str(folder), "logo.png", PNG, allowed=allowed)
    assert e.value.code == "exists"
    r2 = ws.save_asset_to_workspace(str(folder), "logo.png", PNG + b"2", allowed=allowed, overwrite=True)
    assert r2["overwrote"] is True and os.path.exists(r2["backup"])
    for name, data, code in [
        ("logo.jpg", PNG, "mismatch"),
        ("x.png", b"not an image", "content"),
        ("x.png", b"", "size"),
    ]:
        with pytest.raises(WorkspaceWriteError) as e:
            ws.save_asset_to_workspace(str(folder), name, data, allowed=allowed)
        assert e.value.code == code
    with pytest.raises(WorkspaceWriteError) as e:
        ws.save_asset_to_workspace(str(tmp_path / "other"), "logo.png", PNG, allowed=allowed)
    assert e.value.code == "folder"
