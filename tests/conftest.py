import pytest

from creatio_case_lookup import claude_run


@pytest.fixture(autouse=True)
def no_app_settings(monkeypatch, tmp_path_factory):
    """Keep the project's own .claude/settings.json (model, effort, output style)
    out of every test: runs would otherwise gain a --settings flag and a model
    that depend on how this checkout happens to be configured."""
    monkeypatch.setattr(claude_run, "APP_SETTINGS_PATH", tmp_path_factory.mktemp("nosettings") / "settings.json")
