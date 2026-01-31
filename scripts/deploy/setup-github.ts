#!/usr/bin/env npx tsx
/**
 * GitHub App setup wizard.
 * Provides guided setup process for GitHub App integration.
 */

import * as logger from './utils/logger.js';
import {
  displaySetupGuide,
  displayCredentialsReference,
  collectGitHubAppCredentials,
  validateCredentials,
  generateEnvExports,
  generateGitHubSecretsCommands,
  generateAppCreationUrl,
} from './utils/github.js';
import { loadConfigFromEnv } from './utils/config.js';

// ============================================================================
// Types
// ============================================================================

interface SetupGitHubOptions {
  baseDomain?: string;
  openBrowser?: boolean;
  collectCredentials?: boolean;
  showReference?: boolean;
  verbose?: boolean;
}

// ============================================================================
// Main Setup Flow
// ============================================================================

async function runSetupGitHub(options: SetupGitHubOptions): Promise<void> {
  const {
    baseDomain,
    openBrowser = false,
    collectCredentials = false,
    showReference = false,
  } = options;

  logger.header('GitHub App Setup Wizard');
  logger.newline();

  // Determine base domain
  let domain = baseDomain;
  if (!domain) {
    const config = loadConfigFromEnv(process.env, {});
    domain = config.cloudflare?.baseDomain || 'your-domain.com';
  }

  // Show reference if requested
  if (showReference) {
    displayCredentialsReference();
    return;
  }

  // Display setup guide
  displaySetupGuide(domain);

  // Open browser if requested
  if (openBrowser) {
    const url = generateAppCreationUrl(domain);
    logger.newline();
    logger.info('Opening browser to create GitHub App...');

    try {
      const { exec } = await import('child_process');
      const { promisify } = await import('util');
      const execAsync = promisify(exec);

      // Detect platform and open browser
      const platform = process.platform;
      let command: string;

      if (platform === 'darwin') {
        command = `open "${url}"`;
      } else if (platform === 'win32') {
        command = `start "" "${url}"`;
      } else {
        command = `xdg-open "${url}"`;
      }

      await execAsync(command);
      logger.success('Browser opened');
    } catch (error) {
      logger.warning('Could not open browser automatically');
      logger.info('Please copy and paste this URL into your browser:');
      logger.info(url);
    }
  }

  // Collect credentials if requested
  if (collectCredentials) {
    logger.newline();
    logger.section('Credential Collection');

    const credentials = await collectGitHubAppCredentials();

    if (!credentials) {
      logger.error('Failed to collect credentials');
      process.exit(1);
    }

    // Validate credentials
    const validation = validateCredentials(credentials);

    if (!validation.valid) {
      logger.error('Invalid credentials:');
      validation.errors.forEach((err) => logger.error(`  - ${err}`));
      process.exit(1);
    }

    logger.success('Credentials validated');

    // Display environment variable exports
    logger.newline();
    logger.section('Environment Variables');
    logger.info('Add these to your .env.local or GitHub secrets:');
    logger.newline();
    console.log(generateEnvExports(credentials));

    // Display GitHub CLI commands
    logger.newline();
    logger.section('GitHub CLI Commands');
    logger.info('Or use the GitHub CLI to set repository secrets:');
    logger.newline();
    console.log(generateGitHubSecretsCommands(credentials));
  }

  // Final instructions
  logger.newline();
  logger.section('Next Steps');
  logger.info(`
After creating your GitHub App and configuring credentials:

1. Re-run the deployment with GitHub credentials:
   pnpm deploy:setup --environment production

2. Or set the credentials as GitHub repository secrets:
   - GH_APP_ID
   - GH_CLIENT_ID
   - GH_CLIENT_SECRET
   - GH_APP_PRIVATE_KEY

3. Verify the setup by signing in with GitHub on your deployed app
`);
}

// ============================================================================
// CLI Entry Point
// ============================================================================

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // Parse CLI arguments
  const options: SetupGitHubOptions = {
    openBrowser: args.includes('--open-browser') || args.includes('-o'),
    collectCredentials: args.includes('--collect') || args.includes('-c'),
    showReference: args.includes('--reference') || args.includes('-r'),
    verbose: args.includes('--verbose') || args.includes('-v'),
  };

  // Check for domain flag
  const domainIndex = args.findIndex((a) => a === '--domain' || a === '-d');
  if (domainIndex !== -1 && args[domainIndex + 1]) {
    options.baseDomain = args[domainIndex + 1];
  }

  // Check for help
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
GitHub App Setup Wizard

Usage: pnpm setup:github [options]

Options:
  -d, --domain <domain>   Base domain for your deployment
  -o, --open-browser      Open browser to create GitHub App
  -c, --collect           Interactively collect credentials
  -r, --reference         Show credentials reference guide
  -v, --verbose           Verbose output
  -h, --help              Show this help message

Examples:
  pnpm setup:github --domain workspaces.example.com
  pnpm setup:github --open-browser
  pnpm setup:github --collect
  pnpm setup:github --reference
`);
    return;
  }

  try {
    await runSetupGitHub(options);
  } catch (error) {
    logger.error('Error during GitHub App setup:');
    logger.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

// Run if executed directly
main();
