import json
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
PLUGIN_ROOT = REPO_ROOT / "plugins" / "gmail"
GMAIL_CONNECTOR_ID = "connector_2128aebfecb84f64a069897515042a44"


def test_gmail_plugin_manifest_and_skill_paths_exist() -> None:
    manifest = json.loads((PLUGIN_ROOT / ".codex-plugin" / "plugin.json").read_text())
    app_config = json.loads((PLUGIN_ROOT / ".app.json").read_text())

    assert manifest["name"] == "gmail"
    assert manifest["skills"] == "./skills/"
    assert manifest["apps"] == "./.app.json"
    assert manifest["repository"] == "https://github.com/openai/oai-maintained-plugins"
    assert (PLUGIN_ROOT / "skills" / "gmail" / "SKILL.md").is_file()
    assert (PLUGIN_ROOT / "skills" / "gmail-inbox-triage" / "SKILL.md").is_file()
    assert (PLUGIN_ROOT / "assets" / "gmail.png").is_file()
    assert (PLUGIN_ROOT / "assets" / "gmail-small.svg").is_file()
    assert app_config["apps"]["gmail"]["id"] == GMAIL_CONNECTOR_ID


def test_pasted_gmail_link_workflow_is_bounded_and_fast_fails() -> None:
    workflow = (
        PLUGIN_ROOT
        / "skills"
        / "gmail"
        / "references"
        / "pasted-link-workflow.md"
    ).read_text()

    assert "https://mail.google.com/mail/u/<account-index>/#<mailbox-view>/<token>" in workflow
    assert "https://mail.google.com/mail/#<mailbox-view>/<token>" in workflow
    assert "with the token as a message ID" in workflow
    assert 'and `id_type="thread"`' in workflow
    assert "Do not broaden the attempt into `search_emails`" in workflow
    assert "stop after the second attempt" in workflow
    assert "sender, subject, and approximate date" in workflow


def test_pasted_gmail_link_evals_cover_success_and_recovery() -> None:
    eval_file = json.loads(
        (PLUGIN_ROOT / "skills" / "gmail" / "evals" / "evals.json").read_text()
    )
    evals = eval_file["evals"]
    prompts = [case["prompt"] for case in evals]

    assert eval_file["skill_name"] == "gmail"
    assert len(evals) == 4
    assert any("#all/18f7abc123" in prompt for prompt in prompts)
    assert any("#inbox/18f7def456?attachment_id=" in prompt for prompt in prompts)
    assert any("#search/from%3Aalice/project-update" in prompt for prompt in prompts)
    assert any("neither the message-ID nor thread-ID lookup finds it" in prompt for prompt in prompts)


def test_gmail_plugin_is_registered_in_marketplace() -> None:
    marketplace = json.loads((REPO_ROOT / ".agents" / "plugins" / "marketplace.json").read_text())
    entry = next(plugin for plugin in marketplace["plugins"] if plugin["name"] == "gmail")

    assert entry["source"]["path"] == "./plugins/gmail"
    assert entry["policy"]["installation"] == "AVAILABLE"
    assert entry["policy"]["authentication"] == "ON_INSTALL"
    assert entry["category"] == "Communication"
