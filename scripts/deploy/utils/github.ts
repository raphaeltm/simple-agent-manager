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
}

export interface GitHubAppManifest {
  name: string;
  url: string;
  hook_url?: string;
  redirect_url: string;
  description: string;
  public: boolean;
  default_events: string[];
  default_permissions: {
    contents: string;
    metadata: string;
    statuses: string;
  };
}

// ============================================================================
// App Manifest Generation (T058)
// ============================================================================

/**
 * Generate a GitHub App manifest for automatic app creation.
 */
export function generateAppManifest(
  appName: string,
  baseDomain: string
): GitHubAppManifest {
  const webUrl = `https://app.${baseDomain}`;
  const apiUrl = `https://api.${baseDomain}`;

  return {
    name: appName,
    url: webUrl,
    hook_url: `${apiUrl}/api/github/webhook`,
    redirect_url: `${apiUrl}/api/auth/github/callback`,
    description: 'Simple Agent Manager - AI Coding Agent Environment Manager',
    public: false,
    default_events: ['push', 'pull_request'],
    default_permissions: {
      contents: 'read',
      metadata: 'read',
      statuses: 'read',
    },
  };
}

/**
 * Generate a URL to create a GitHub App with pre-filled settings.
 */
export function generateAppCreationUrl(
  baseDomain: string,
  appName: string = 'SAM Dev Agent'
): string {
  const manifest = generateAppManifest(appName, baseDomain);
  const encodedManifest = encodeURIComponent(JSON.stringify(manifest));

  // GitHub App Manifest flow
  return `https://github.com/settings/apps/new?manifest=${encodedManifest}`;
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

    logger.info('');
    const appPrivateKey = await promptMultiline(
      rl,
      'GitHub App Private Key (PEM format):'
    );

    if (!appPrivateKey || !appPrivateKey.includes('-----BEGIN')) {
      logger.error('Private key must be in PEM format');
      return null;
    }

    return {
      clientId,
      clientSecret,
      appId,
      appPrivateKey,
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

1. Go to GitHub Settings:
   https://github.com/settings/apps/new

2. Fill in the required fields:

   📝 App Name: SAM Dev Agent (or your preferred name)

   🌐 Homepage URL:
   ${webUrl}

   🔗 Callback URL:
   ${apiUrl}/api/auth/github/callback

   🪝 Webhook URL (optional):
   ${apiUrl}/api/github/webhook

3. Set Permissions:
   - Repository contents: Read
   - Repository metadata: Read
   - Commit statuses: Read

4. After creating the app, collect these values:
   - App ID (shown on the app settings page)
   - Client ID (from OAuth credentials)
   - Client Secret (generate one in OAuth credentials)
   - Private Key (generate and download .pem file)

5. Add these as secrets in your GitHub repository:
   - GH_APP_ID
   - GH_CLIENT_ID
   - GH_CLIENT_SECRET
   - GH_APP_PRIVATE_KEY

💡 Tip: You can use the manifest URL below to pre-fill most settings:
`);

  const manifestUrl = generateAppCreationUrl(baseDomain);
  logger.keyValue('Manifest URL', manifestUrl);
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
│ GITHUB_CLIENT_ID       │ OAuth 2.0 Client ID                         │
│ GITHUB_CLIENT_SECRET   │ OAuth 2.0 Client Secret                     │
│ GITHUB_APP_ID          │ Numeric App ID from settings page           │
│ GITHUB_APP_PRIVATE_KEY │ Private key (.pem file contents)            │
└────────────────────────┴─────────────────────────────────────────────┘

Where to find these:
1. Go to: https://github.com/settings/apps/YOUR-APP-NAME
2. App ID is shown at the top of the page
3. Client ID/Secret are in the "OAuth credentials" section
4. Generate Private Key in the "Private keys" section
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

/**
 * Generate environment variable export commands.
 */
export function generateEnvExports(config: GitHubAppConfig): string {
  // Escape the private key for shell
  const escapedKey = config.appPrivateKey.replace(/'/g, "'\\''");

  return `
# Add these to your .env.local file or GitHub repository secrets:

GITHUB_CLIENT_ID='${config.clientId}'
GITHUB_CLIENT_SECRET='${config.clientSecret}'
GITHUB_APP_ID='${config.appId}'
GITHUB_APP_PRIVATE_KEY='${escapedKey}'
`.trim();
}

/**
 * Generate GitHub repository secrets commands.
 */
export function generateGitHubSecretsCommands(config: GitHubAppConfig): string {
  return `
# Run these commands to set GitHub repository secrets:
# (requires gh CLI to be installed and authenticated)

gh secret set GH_CLIENT_ID --body "${config.clientId}"
gh secret set GH_CLIENT_SECRET --body "${config.clientSecret}"
gh secret set GH_APP_ID --body "${config.appId}"
gh secret set GH_APP_PRIVATE_KEY < path/to/private-key.pem
`.trim();
}
