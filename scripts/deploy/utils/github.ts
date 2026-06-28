/**
 * GitHub App setup utilities.
 * Provides guided setup process for GitHub App integration.
 */

import * as readline from 'readline';
import * as logger from './logger.js';

// ============================================================================
// Types
// ============================================================================

export interface GitHubAppConfig {
  clientId: string;
  clientSecret: string;
  appId: string;
  appPrivateKey: string;
  appSlug: string;
  webhookSecret: string;
}

export interface GitHubAppManifest {
  name: string;
  url: string;
  hook_url?: string;
  redirect_url: string;
  callback_urls: string[];
  setup_url: string;
  setup_on_update: boolean;
  description: string;
  public: boolean;
  default_events: string[];
  default_permissions: {
    contents: string;
    metadata: string;
    email_addresses: string;
    pull_requests: string;
  };
}

// ============================================================================
// App Manifest Generation (T058)
// ============================================================================

/**
 * Generate a GitHub App manifest for automatic app creation.
 */
export function generateAppManifest(appName: string, baseDomain: string): GitHubAppManifest {
  const webUrl = `https://app.${baseDomain}`;
  const apiUrl = `https://api.${baseDomain}`;

  return {
    name: appName,
    url: webUrl,
    hook_url: `${apiUrl}/api/github/webhook`,
    redirect_url: `${apiUrl}/api/github/callback`,
    callback_urls: [`${apiUrl}/api/auth/callback/github`],
    setup_url: `${apiUrl}/api/github/callback`,
    setup_on_update: true,
    description: 'Simple Agent Manager - AI Coding Agent Environment Manager',
    public: false,
    default_events: ['push', 'pull_request'],
    default_permissions: {
      contents: 'write',
      metadata: 'read',
      email_addresses: 'read',
      pull_requests: 'read',
    },
  };
}

/**
 * Generate a URL to create a GitHub App with pre-filled settings.
 */
export function generateAppCreationUrl(baseDomain: string, appName: string = 'SAM'): string {
  const apiUrl = `https://api.${baseDomain}`;
  const params = new URLSearchParams();

  params.set('name', appName);
  params.set('url', `https://app.${baseDomain}`);
  params.append('callback_urls[]', `${apiUrl}/api/auth/callback/github`);
  params.set('setup_url', `${apiUrl}/api/github/callback`);
  params.set('setup_on_update', 'true');
  params.set('public', 'false');
  params.set('webhook_active', 'true');
  params.set('webhook_url', `${apiUrl}/api/github/webhook`);
  params.set('contents', 'write');
  params.set('metadata', 'read');
  params.set('email_addresses', 'read');
  params.set('pull_requests', 'read');
  params.append('events[]', 'push');
  params.append('events[]', 'pull_request');

  return `https://github.com/settings/apps/new?${params.toString()}`;
}

/**
 * Generate a manual app creation URL (simpler approach).
 */
export function generateManualAppUrl(): string {
  return 'https://github.com/settings/apps/new';
}

// ============================================================================
// Interactive Prompts (T057)
// ============================================================================

function createReadlineInterface(): readline.Interface {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
}

async function prompt(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      resolve(answer.trim());
    });
  });
}

async function promptMultiline(
  rl: readline.Interface,
  question: string,
  endMarker: string = 'END'
): Promise<string> {
  console.log(question);
  console.log(`(Enter your input, then type '${endMarker}' on a new line when done)`);

  const lines: string[] = [];

  return new Promise((resolve) => {
    const lineHandler = (line: string) => {
      if (line.trim() === endMarker) {
        rl.removeListener('line', lineHandler);
        resolve(lines.join('\n'));
      } else {
        lines.push(line);
      }
    };

    rl.on('line', lineHandler);
  });
}

/**
 * Interactively collect GitHub App credentials.
 */
export async function collectGitHubAppCredentials(): Promise<GitHubAppConfig | null> {
  const rl = createReadlineInterface();

  try {
    logger.info('');
    logger.info('Please enter your GitHub App credentials:');
    logger.info('(You can find these in your GitHub App settings)');
    logger.info('');

    const clientId = await prompt(rl, 'GitHub OAuth Client ID: ');
    if (!clientId) {
      logger.error('Client ID is required');
      return null;
    }

    const clientSecret = await prompt(rl, 'GitHub OAuth Client Secret: ');
    if (!clientSecret) {
      logger.error('Client Secret is required');
      return null;
    }

    const appId = await prompt(rl, 'GitHub App ID: ');
    if (!appId || !/^\d+$/.test(appId)) {
      logger.error('App ID must be a number');
      return null;
    }

    const appSlug = await prompt(rl, 'GitHub App slug (from github.com/apps/<slug>): ');
    if (!appSlug) {
      logger.error('App slug is required');
      return null;
    }

    const webhookSecret = await prompt(rl, 'GitHub App webhook secret: ');
    if (!webhookSecret) {
      logger.error('Webhook secret is required');
      return null;
    }

    logger.info('');
    const appPrivateKey = await promptMultiline(rl, 'GitHub App Private Key (PEM format):');

    if (!appPrivateKey || !appPrivateKey.includes('-----BEGIN')) {
      logger.error('Private key must be in PEM format');
      return null;
    }

    return {
      clientId,
      clientSecret,
      appId,
      appPrivateKey,
      appSlug,
      webhookSecret,
    };
  } finally {
    rl.close();
  }
}

// ============================================================================
// Setup Guide (T056)
// ============================================================================

/**
 * Display the GitHub App setup guide.
 */
export function displaySetupGuide(baseDomain: string): void {
  const webUrl = `https://app.${baseDomain}`;
  const apiUrl = `https://api.${baseDomain}`;

  logger.section('GitHub App Setup Guide');

  logger.info(`
To enable GitHub authentication, you need to create a GitHub App.
Follow these steps:

1. Open the pre-filled GitHub App URL shown below.

2. Verify the required fields:

   📝 App Name: SAM (or your preferred name)

   🌐 Homepage URL:
   ${webUrl}

   🔗 Callback URL:
   ${apiUrl}/api/auth/callback/github

   🧭 Setup URL:
   ${apiUrl}/api/github/callback
   Enable "Redirect on update" for the Setup URL.

   🪝 Webhook URL:
   ${apiUrl}/api/github/webhook

   Leave "Request user authorization (OAuth) during installation" unchecked.

3. Set Permissions:
   - Repository contents: Read and write
   - Repository metadata: Read
   - Email addresses: Read-only
   - Pull requests: Read-only

4. Subscribe to events:
   - push
   - pull_request

5. After creating the app, collect these values:
   - App ID (shown on the app settings page)
   - Client ID (from OAuth credentials)
   - Client Secret (generate one in OAuth credentials)
   - Private Key (generate and download .pem file)
   - App slug (from github.com/apps/<slug>)
   - Webhook secret (the value you entered on the form)

6. Add these as secrets in your GitHub repository's production environment:
   - GH_APP_ID
   - GH_CLIENT_ID
   - GH_CLIENT_SECRET
   - GH_APP_PRIVATE_KEY
   - GH_APP_SLUG
   - GH_WEBHOOK_SECRET
`);

  const setupUrl = generateAppCreationUrl(baseDomain);
  logger.keyValue('Pre-filled URL', setupUrl);
}

/**
 * Display a quick reference for required credentials.
 */
export function displayCredentialsReference(): void {
  logger.section('Required GitHub Credentials');

  logger.info(`
The following credentials are needed for GitHub authentication:

┌────────────────────────┬─────────────────────────────────────────────┐
│ Credential             │ Description                                  │
├────────────────────────┼─────────────────────────────────────────────┤
│ GH_CLIENT_ID           │ OAuth 2.0 Client ID                         │
│ GH_CLIENT_SECRET       │ OAuth 2.0 Client Secret                     │
│ GH_APP_ID              │ Numeric App ID from settings page           │
│ GH_APP_PRIVATE_KEY     │ Private key (.pem file contents)            │
│ GH_APP_SLUG            │ App URL slug from github.com/apps/<slug>    │
│ GH_WEBHOOK_SECRET      │ GitHub App webhook secret                   │
└────────────────────────┴─────────────────────────────────────────────┘

Where to find these:
1. Go to: https://github.com/settings/apps/YOUR-APP-NAME
2. App ID is shown at the top of the page
3. Client ID/Secret are in the "OAuth credentials" section
4. Generate Private Key in the "Private keys" section
5. App slug is visible in the public app URL
6. Webhook secret is the value you entered when creating the app
`);
}

// ============================================================================
// Credential Validation
// ============================================================================

/**
 * Validate GitHub App credentials format.
 */
export function validateCredentials(config: Partial<GitHubAppConfig>): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  if (!config.clientId) {
    errors.push('Missing GitHub Client ID');
  } else if (!/^Iv\d\.[a-zA-Z0-9]+$/.test(config.clientId)) {
    errors.push('Invalid GitHub Client ID format (expected: Iv1.xxxx)');
  }

  if (!config.clientSecret) {
    errors.push('Missing GitHub Client Secret');
  }

  if (!config.appId) {
    errors.push('Missing GitHub App ID');
  } else if (!/^\d+$/.test(config.appId)) {
    errors.push('GitHub App ID must be numeric');
  }

  if (!config.appSlug) {
    errors.push('Missing GitHub App slug');
  } else if (!/^[a-z0-9][a-z0-9-]*$/i.test(config.appSlug)) {
    errors.push('GitHub App slug must contain only letters, numbers, and hyphens');
  }

  if (!config.webhookSecret) {
    errors.push('Missing GitHub App webhook secret');
  }

  if (!config.appPrivateKey) {
    errors.push('Missing GitHub App Private Key');
  } else if (!config.appPrivateKey.includes('-----BEGIN RSA PRIVATE KEY-----')) {
    errors.push('GitHub App Private Key must be in PEM format');
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Test GitHub App credentials by making an API call.
 */
export async function testGitHubAppCredentials(
  config: GitHubAppConfig
): Promise<{ success: boolean; error?: string }> {
  // For now, just validate the format
  // A more thorough test would require generating a JWT and making an API call
  const validation = validateCredentials(config);

  if (!validation.valid) {
    return {
      success: false,
      error: validation.errors.join(', '),
    };
  }

  // TODO: Implement actual API test
  // This would involve:
  // 1. Generate JWT from App ID and Private Key
  // 2. Call GitHub API to get app info
  // 3. Verify the response

  return { success: true };
}

// ============================================================================
// Environment Variable Output
// ============================================================================

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * Generate environment variable export commands.
 */
export function generateEnvExports(config: GitHubAppConfig): string {
  return `
# Add these to your .env.local file:

GITHUB_CLIENT_ID=${shellSingleQuote(config.clientId)}
GITHUB_CLIENT_SECRET=${shellSingleQuote(config.clientSecret)}
GITHUB_APP_ID=${shellSingleQuote(config.appId)}
GITHUB_APP_PRIVATE_KEY=${shellSingleQuote(config.appPrivateKey)}
GITHUB_APP_SLUG=${shellSingleQuote(config.appSlug)}
GITHUB_WEBHOOK_SECRET=${shellSingleQuote(config.webhookSecret)}
`.trim();
}

/**
 * Generate GitHub repository secrets commands.
 */
export function generateGitHubSecretsCommands(config: GitHubAppConfig): string {
  return `
# Run these commands to set GitHub repository secrets:
# (requires gh CLI to be installed and authenticated)

gh secret set GH_CLIENT_ID --env production --body ${shellSingleQuote(config.clientId)}
gh secret set GH_CLIENT_SECRET --env production --body ${shellSingleQuote(config.clientSecret)}
gh secret set GH_APP_ID --env production --body ${shellSingleQuote(config.appId)}
gh secret set GH_APP_SLUG --env production --body ${shellSingleQuote(config.appSlug)}
gh secret set GH_WEBHOOK_SECRET --env production --body ${shellSingleQuote(config.webhookSecret)}
gh secret set GH_APP_PRIVATE_KEY --env production < path/to/private-key.pem
`.trim();
}
