# ADR-001: GitHub App over OAuth for Repository Access

## Status

Accepted

## Context

Cloud AI Workspaces needs to clone user repositories when creating workspaces. There are two main approaches for accessing user repositories on GitHub:

1. **GitHub OAuth App**: User grants broad permissions, we store long-lived access tokens
2. **GitHub App**: User installs app on specific repos, we get short-lived installation tokens

## Decision

We chose to use **GitHub App** for repository access instead of relying solely on OAuth.

## Consequences

### Positive

1. **Fine-grained permissions**: Users grant access only to specific repositories, not all their repos
2. **Short-lived tokens**: Installation tokens expire in 1 hour, reducing security risk if compromised
3. **No stored user tokens**: We don't store long-lived user access tokens for repo access
4. **Organization support**: Works seamlessly with organization repositories
5. **Better UX for orgs**: Org admins can install once for the whole org
6. **Audit trail**: GitHub logs all app actions separately from user actions
7. **Rate limits**: Higher rate limits than OAuth (5000/hour per installation)

### Negative

1. **Two auth systems**: Users need both OAuth (login) and GitHub App (repos)
2. **Installation UX**: Users must install the app, which is an extra step
3. **Complexity**: Managing two types of GitHub credentials
4. **App management**: Need to maintain the GitHub App configuration

### Neutral

1. **Webhook support**: GitHub Apps get webhooks, which we use for installation sync
2. **JWT complexity**: Need to implement JWT signing for app authentication

## Alternatives Considered

### OAuth Only

- Simpler implementation
- But requires storing long-lived tokens
- Grants access to all repositories user can access
- Users can't scope access to specific repos

### Personal Access Tokens

- User provides their own PAT
- Simple to implement
- But tokens are long-lived and powerful
- Users must manage their own tokens
- Poor security hygiene

## Implementation Notes

1. **User Authentication**: GitHub OAuth App for login (session-based)
2. **Repository Access**: GitHub App with installation tokens
3. **Token Flow**:
   - User logs in via OAuth → Session cookie
   - User installs GitHub App → Installation ID stored
   - Workspace creation → Generate installation token (1hr)
   - Token passed to VM via cloud-init (HTTPS only)

## References

- [GitHub Apps vs OAuth Apps](https://docs.github.com/en/developers/apps/getting-started-with-apps/about-apps)
- [Installation Access Tokens](https://docs.github.com/en/rest/apps/apps#create-an-installation-access-token-for-an-app)
