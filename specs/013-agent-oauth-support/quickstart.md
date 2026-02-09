# Quick Start: Using OAuth Tokens with Claude Code

This guide shows how to use your Claude Max/Pro subscription with SAM instead of API keys.

## Prerequisites

- Claude Max or Pro subscription
- Claude CLI installed locally (`npm install -g @anthropics/claude`)
- SAM account with GitHub authentication

## Step 1: Generate Your OAuth Token

On your local machine, generate an OAuth token from your Claude subscription:

```bash
# Option A: Interactive browser flow
claude login

# Option B: Direct token generation
claude setup-token
```

The command will output a long token string. Copy this token - you'll need it in the next step.

> **Note**: This token is tied to your Claude subscription and will use your Max/Pro quota, not API credits.

## Step 2: Add OAuth Token in SAM Settings

1. Log into SAM at `https://app.simple-agent-manager.org`
2. Navigate to **Settings** → **Agent API Keys**
3. Find the **Claude Code** card
4. Click **Add OAuth Token** (or **Update** if you already have an API key)
5. Select **OAuth Token (Pro/Max subscription)** from the dropdown
6. Paste your token from Step 1
7. Click **Save**

The card will update to show "Connected (Pro/Max)" with your OAuth token active.

## Step 3: Using OAuth in Your Workspace

When you open a workspace and select Claude Code:

1. The system automatically uses your active credential
2. If you have both API key and OAuth token, the most recently saved one is active
3. You can switch between them in Settings at any time

### Verify OAuth is Active

In your workspace, Claude Code will authenticate using your subscription. You can verify this by:

1. Check the Settings page - it shows which credential type is active
2. Monitor your Claude Max/Pro usage at `claude.ai/settings/usage`
3. API key usage remains at $0 when using OAuth

## Step 4: Switching Between Credentials

You can have both an API key and OAuth token saved:

### To Switch Active Credential

1. Go to **Settings** → **Agent API Keys**
2. Find **Claude Code**
3. You'll see both credentials listed with an active indicator
4. Click **Make Active** on the credential you want to use
5. New workspaces will use the newly activated credential

### When to Use Each

- **OAuth Token**: When you have remaining Max/Pro quota
- **API Key**: When you've exhausted subscription quota or need guaranteed availability

## Troubleshooting

### "OAuth token expired" Error

Your subscription token has expired. Generate a new one:

```bash
claude setup-token
```

Then update it in SAM Settings.

### "Invalid token format" Warning

You may have pasted an API key in the OAuth field (or vice versa). Check that:
- API keys start with `sk-ant-`
- OAuth tokens are longer and don't follow the API key format

### Token Not Working

1. Verify your Claude subscription is active at `claude.ai/settings/plan`
2. Ensure you selected "OAuth Token" (not "API Key") when saving
3. Try generating a fresh token with `claude setup-token`

## Advanced: Using Both Credential Types

SAM supports storing both an API key and OAuth token for flexibility:

```
Claude Code Credentials:
├── API Key (...abc1)
└── OAuth Token (...xyz2) ← Active ✓
```

**Use Cases**:
- **Development**: Use OAuth token (subscription quota)
- **Production/CI**: Use API key (predictable billing)
- **Quota Management**: Switch to API key when subscription quota is low

## Security Notes

- OAuth tokens are encrypted with AES-256-GCM, same as API keys
- Tokens are never logged or exposed in plaintext
- Each token is tied to your user account and cannot be shared
- Tokens don't auto-refresh - you must manually update when expired

## Limitations (v1)

- Only Claude Code supports OAuth tokens currently
- OpenAI Codex and Gemini CLI OAuth support coming in future release
- No automatic token refresh - manual update required
- No browser-based OAuth flow - must use CLI to generate tokens

## Next Steps

- [Learn about idle timeout configuration](../../docs/guides/idle-timeout.md)
- [Set up GitHub App for private repositories](../../docs/guides/github-app-setup.md)
- [Configure multiple cloud providers](../../docs/guides/multi-provider.md)