# Workspace Branch Selection

## Summary

When creating a workspace, users should be able to select which branch to clone from the chosen repository. Currently, workspace creation defaults to the repository's default branch with no option to change it.

The UI should offer a dropdown populated with the repository's branches (fetched via the GitHub API), along with free-text input for typing a branch name directly (useful for repos with many branches or for entering a branch that hasn't been pushed yet).

## User Story

As a user creating a workspace, I want to pick a specific branch from my repository so that I can start working on feature branches, bugfix branches, or any non-default branch without having to manually switch after the workspace is created.

## Requirements

- [ ] Add a branch selector to the workspace creation form (dropdown + free-text combo)
- [ ] Fetch branches from the GitHub API when a repository is selected
- [ ] Default to the repository's default branch (pre-selected)
- [ ] Allow free-text entry for arbitrary branch/ref names
- [ ] Pass the selected branch to the workspace provisioning flow
- [ ] Cloud-init / devcontainer setup clones the specified branch instead of default

## Implementation Notes

### API

- Need a new endpoint or extend `GET /api/github/repositories` to return branches for a given repo (or a dedicated `GET /api/github/repositories/:owner/:repo/branches`)
- GitHub App needs "Contents: Read" permission (likely already granted) to list branches
- Consider pagination — repos can have hundreds of branches

### UI

- Combobox pattern: dropdown list of branches with type-ahead filtering
- Only fetch branches after a repository is selected
- Show loading state while branches are being fetched
- Graceful fallback if branch listing fails (allow free-text entry)

### Provisioning

- `git clone --branch <branch>` in cloud-init template
- Verify the branch parameter is passed through: API → cloud-init generator → VM setup
- Handle edge case: branch doesn't exist (fail fast with clear error)

## Open Questions

- Should we support tags and commit SHAs in addition to branches?
- Should we cache branch lists (they can change frequently)?
- Rate limiting considerations for GitHub API branch listing calls?
