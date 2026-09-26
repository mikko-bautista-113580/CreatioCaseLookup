"""Settings tab → Claude settings: .claude/settings.json read/write and the
guarantee that every AI run gets the model, effort and output style from it."""

import json

import pytest
from fastapi.testclient import TestClient

from creatio_case_lookup import analyze, claude_run, lifecycle_export, server


@pytest.fixture
def settings(tmp_path, monkeypatch):
    p = tmp_path / ".claude" / "settings.json"
    p.parent.mkdir()
    p.write_text(json.dumps({"model": "claude-opus-5-5", "effortLevel": "medium", "outputStyle": "Concise",
                             "permissions": {"allow": ["Read"]}}), encoding="utf-8")
    monkeypatch.setattr(claude_run, "APP_SETTINGS_PATH", p)
    monkeypatch.delenv("CREATIO_APP_MODEL", raising=False)
    return p


def test_write_keeps_other_keys(settings):
    out = claude_run.write_app_settings({"model": "claude-sonnet-5", "effortLevel": "high"})
    assert out == {"model": "claude-sonnet-5", "effortLevel": "high", "outputStyle": "Concise"}
    raw = json.loads(settings.read_text(encoding="utf-8"))
    assert raw["permissions"] == {"allow": ["Read"]}


@pytest.mark.parametrize("bad", [{"model": "gpt-4"}, {"effortLevel": "turbo"}, {"outputStyle": "x;rm"}, {"hooks": "x"}])
def test_write_rejects_bad_values(settings, bad):
    with pytest.raises(ValueError):
        claude_run.write_app_settings(bad)
    assert json.loads(settings.read_text(encoding="utf-8"))["model"] == "claude-opus-5-5"


def test_settings_model_beats_env(settings, monkeypatch):
    monkeypatch.setenv("CREATIO_APP_MODEL", "claude-haiku-4-5-20251001")
    assert analyze.default_model() == "claude-opus-5-5"


def test_routes_round_trip(settings, monkeypatch):
    monkeypatch.setattr("creatio_case_lookup.env.read_env_file", lambda: {})
    with TestClient(server.app) as c:
        d = c.get("/api/claude-settings").json()
        assert (d["model"], d["effortLevel"], d["outputStyle"]) == ("claude-opus-5-5", "medium", "Concise")
        assert d["effectiveModel"] == "claude-opus-5-5" and "claude-sonnet-5" in d["choices"]["model"]
        r = c.post("/api/claude-settings", json={"model": "claude-sonnet-5", "effortLevel": "low", "outputStyle": "Concise"})
        assert r.status_code == 200 and r.json()["effectiveModel"] == "claude-sonnet-5"
        assert c.post("/api/claude-settings", json={"effortLevel": "turbo"}).status_code == 400


def test_publish_run_uses_the_settings(settings, monkeypatch, tmp_path):
    """Artifact publishing gets the same model (and the --settings file) as every other run."""
    import asyncio

    seen = {}

    def fake_run(spec, on_chunk, on_done, on_error, on_tool_use=None):
        seen["spec"] = spec
        on_done({"resultText": "https://claude.ai/artifact/Xy1"})

    monkeypatch.setattr(lifecycle_export, "run_claude", fake_run)
    monkeypatch.setattr(lifecycle_export._paths, "ANALYSIS_DIR", tmp_path)
    asyncio.run(lifecycle_export.publish_report("<p>x</p>", "r9"))
    assert seen["spec"].model == "claude-opus-5-5"
    assert seen["spec"].settings_file is None  # None → claude_run passes the app's settings file


def test_every_ai_entry_point_resolves_model_through_default_model():
    """Guard: no run picks its own model outside default_model()."""
    import inspect

    from creatio_case_lookup import analyze_workspace, fix_plan

    for mod in (analyze, analyze_workspace, fix_plan, lifecycle_export):
        assert "default_model()" in inspect.getsource(mod), mod.__name__
    # Only default_model() reads the fallback; no run reads it on its own.
    for mod in (analyze_workspace, fix_plan, lifecycle_export):
        assert "CREATIO_APP_MODEL" not in inspect.getsource(mod), mod.__name__
    assert "APP_MODEL:" not in inspect.getsource(server)
