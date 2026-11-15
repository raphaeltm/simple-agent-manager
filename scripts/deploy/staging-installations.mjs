/**
 * Extra non-production installations that reuse an existing GitHub Environment's credentials.
 *
 * A GitHub Environment supplies credentials (Cloudflare token, R2 keys, Pulumi passphrase). An
 * installation is what a deploy targets: domain, zone, Pulumi stack and resource prefix. The
 * primary installation of an environment has the environment's own name and takes its identity
 * from the Environment's variables (BASE_DOMAIN, RESOURCE_PREFIX). The installations listed here
 * are secondary: they run with another environment's secrets and differ only in target, so a
 * second staging needs no copied secrets.
 *
 * This list is the allowlist. A deploy or teardown that names any installation other than the
 * environment itself must find it here, and every check below fails closed. It is not the
 * production boundary on its own: the `staging` Environment holds only the staging Cloudflare
 * account's credentials, and the `production` Environment deploys only from `main`.
 */

/** @typedef {{ credentialEnvironment: string, baseDomain: string, resourcePrefix: string, stack: string }} SecondaryInstallation */

/** @type {Readonly<Record<string, Readonly<SecondaryInstallation>>>} */
export const SECONDARY_INSTALLATIONS = Object.freeze({
  // Second staging (idea 01M7FYGMEESYH3AJZJ0CT3NKCZ): its own zone in the staging account.
  staging2: Object.freeze({
    credentialEnvironment: 'staging',
    baseDomain: 'sammy2.party',
    resourcePrefix: 'sam2',
    stack: 'staging2',
  }),
});

const INSTALLATION_NAME = /^[a-z][a-z0-9-]{0,30}[a-z0-9]$/u;

/** Production in any spelling: an exact name, a stack alias, or a substring like `prod2`. */
function looksLikeProduction(value) {
  return /prod/iu.test(value);
}

/**
 * Resolve what a deploy or teardown targets.
 *
 * @param {{ environment: string, installation?: string, primary: { baseDomain?: string, prefix: string, stack: string } }} input
 *   `environment` is the GitHub Environment the job runs in; `installation` the requested target
 *   (empty means the environment's own installation); `primary` the names already resolved for
 *   the environment's own installation.
 * @returns {{ installation: string, secondary: boolean, entry?: SecondaryInstallation }}
 */
export function resolveInstallation({ environment, installation, primary }) {
  const requested = (installation ?? '').trim();
  if (requested === '' || requested === environment) {
    return { installation: environment, secondary: false };
  }

  if (!INSTALLATION_NAME.test(requested)) {
    throw new Error('installation must be a lowercase name of letters, numbers and hyphens.');
  }
  if (looksLikeProduction(requested) || looksLikeProduction(environment)) {
    throw new Error(
      `Refusing installation '${requested}' with environment '${environment}': secondary installations never run against production.`
    );
  }
  if (!Object.hasOwn(SECONDARY_INSTALLATIONS, requested)) {
    throw new Error(
      `Unknown installation '${requested}'. Known: ${Object.keys(SECONDARY_INSTALLATIONS).join(', ')}.`
    );
  }

  const entry = SECONDARY_INSTALLATIONS[requested];
  if (entry.credentialEnvironment !== environment) {
    throw new Error(
      `Installation '${requested}' uses the '${entry.credentialEnvironment}' environment's credentials, not '${environment}'.`
    );
  }
  if (looksLikeProduction(entry.stack) || looksLikeProduction(entry.resourcePrefix)) {
    throw new Error(`Installation '${requested}' has a production-like stack or prefix.`);
  }
  if (entry.stack === primary.stack || entry.stack === environment) {
    throw new Error(
      `Installation '${requested}' would reuse the primary stack '${primary.stack}'.`
    );
  }
  if (entry.resourcePrefix === primary.prefix) {
    throw new Error(
      `Installation '${requested}' would reuse the primary resource prefix '${primary.prefix}'.`
    );
  }
  if (primary.baseDomain && entry.baseDomain.toLowerCase() === primary.baseDomain.toLowerCase()) {
    throw new Error(
      `Installation '${requested}' would reuse the primary domain '${primary.baseDomain}'.`
    );
  }

  return { installation: requested, secondary: true, entry };
}

/**
 * The GitHub Environment whose secrets a requested installation runs with: the registered
 * environment for a secondary installation, otherwise the installation's own name.
 */
export function credentialEnvironmentFor(installation) {
  const requested = (installation ?? '').trim();
  if (!INSTALLATION_NAME.test(requested)) {
    throw new Error('installation must be a lowercase name of letters, numbers and hyphens.');
  }
  return Object.hasOwn(SECONDARY_INSTALLATIONS, requested)
    ? SECONDARY_INSTALLATIONS[requested].credentialEnvironment
    : requested;
}

/**
 * Everything a staging workflow needs to target an installation: the environment whose
 * credentials it uses, the `installation` input for deploy-reusable.yml (empty for a primary)
 * and the installation's domain (the primary's own BASE_DOMAIN variable for a primary).
 */
export function workflowTargetFor(installation, primaryBaseDomain) {
  // Staging workflows never target production, under any name.
  if (looksLikeProduction(installation ?? '')) {
    throw new Error(
      `Refusing installation '${installation}': staging workflows never target production.`
    );
  }
  const credentialEnvironment = credentialEnvironmentFor(installation);
  const secondary = Object.hasOwn(SECONDARY_INSTALLATIONS, installation);
  const baseDomain = secondary
    ? SECONDARY_INSTALLATIONS[installation].baseDomain
    : primaryBaseDomain;
  if (!baseDomain) {
    throw new Error(`No domain is known for installation '${installation}'.`);
  }
  return {
    credential_environment: credentialEnvironment,
    installation: secondary ? installation : '',
    base_domain: baseDomain,
  };
}

async function main() {
  const mode = process.argv[2];
  if (mode !== 'credential-environment' && mode !== 'workflow-target') {
    throw new Error('Usage: staging-installations.mjs <credential-environment|workflow-target>');
  }
  const { appendFileSync } = await import('node:fs');
  const outputs =
    mode === 'workflow-target'
      ? workflowTargetFor(process.env.INSTALLATION?.trim() ?? '', process.env.PRIMARY_BASE_DOMAIN)
      : { credential_environment: credentialEnvironmentFor(process.env.INSTALLATION) };
  const lines = Object.entries(outputs).map(([key, value]) => `${key}=${value}`);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join('\n')}\n`);
  }
  console.log(
    `Installation ${process.env.INSTALLATION} runs with the '${outputs.credential_environment}' environment's credentials.`
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
