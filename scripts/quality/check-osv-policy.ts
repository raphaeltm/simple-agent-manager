export interface OsvIgnoreEntry {
  id: string;
  reason?: string;
  expires?: string;
}

export interface OsvPolicyInput {
  eventName: string;
  schedule?: string;
  hasPrivateBacklogRouting: boolean;
  ignores: OsvIgnoreEntry[];
}

export interface OsvPolicyResult {
  ok: boolean;
  errors: string[];
  advisoryRun: boolean;
}

function isFutureIsoDate(value: string, now: Date): boolean {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp > now.getTime();
}

export function validateOsvPolicy(input: OsvPolicyInput, now = new Date()): OsvPolicyResult {
  const errors: string[] = [];
  const advisoryRun = input.eventName === 'schedule' || input.eventName === 'workflow_dispatch';

  if (!advisoryRun && input.eventName !== 'pull_request') {
    errors.push(`Unsupported OSV policy event: ${input.eventName}`);
  }

  if (advisoryRun && !input.hasPrivateBacklogRouting) {
    errors.push('Scheduled OSV advisory follow-up requires private SAM/backlog routing.');
  }

  for (const ignore of input.ignores) {
    if (!ignore.id.trim()) errors.push('Every OSV ignore requires an advisory id.');
    if (!ignore.reason?.trim())
      errors.push(`OSV ignore ${ignore.id || '<missing>'} requires a reason.`);
    if (!ignore.expires || !isFutureIsoDate(ignore.expires, now)) {
      errors.push(`OSV ignore ${ignore.id || '<missing>'} requires a future expiry.`);
    }
  }

  return { ok: errors.length === 0, errors, advisoryRun };
}

export function extractOsvIgnores(config: string): OsvIgnoreEntry[] {
  return config
    .split(/(?=^\s*\[\[)/m)
    .map((section) => {
      const header = /^\s*\[\[(IgnoredVulns|PackageOverrides)\]\]/.exec(section);
      return { block: section, kind: header?.[1] };
    })
    .filter(
      ({ kind, block }) =>
        kind === 'IgnoredVulns' ||
        (kind === 'PackageOverrides' &&
          /^\s*(?:ignore|vulnerability\.ignore)\s*=\s*true\s*$/m.test(block))
    )
    .map(({ block }) => {
      const value = (name: string): string | undefined =>
        new RegExp(`^\\s*${name}\\s*=\\s*["']([^"']+)["']`, 'm').exec(block)?.[1];
      return {
        id: value('id') ?? value('name') ?? '<package-override>',
        reason: value('reason'),
        expires: value('ignoreUntil') ?? value('effectiveUntil'),
      };
    });
}

function main(): void {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const config = readFileSync(resolve(repoRoot, 'osv-scanner.toml'), 'utf8');
  const result = validateOsvPolicy({
    eventName: process.env.OSV_POLICY_EVENT ?? 'pull_request',
    hasPrivateBacklogRouting: process.env.SAM_OSV_PRIVATE_ROUTING_CONFIGURED === 'true',
    ignores: extractOsvIgnores(config),
  });
  if (!result.ok) {
    console.error(
      ['OSV policy check failed:', ...result.errors.map((error) => `- ${error}`)].join('\n')
    );
    process.exit(1);
  }
  console.log('OSV ignore policy passed.');
}

if (import.meta.url === `file://${process.argv[1]}`) main();
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
