-- Store the first SAM platform policy slice on agent profiles.
-- JSON shape: GitHubCliPolicy from packages/shared/src/types/agent-settings.ts.
-- Null means inherit the full GitHub App installation token behavior.
ALTER TABLE agent_profiles ADD COLUMN github_cli_policy TEXT;
