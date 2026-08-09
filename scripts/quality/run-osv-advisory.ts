import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function countOsvVulnerabilities(report: unknown): number {
  if (typeof report !== 'object' || report === null || !('results' in report)) {
    throw new TypeError('OSV-Scanner returned an unexpected report shape.');
  }
  const { results } = report;
  if (!Array.isArray(results)) {
    throw new TypeError('OSV-Scanner returned an unexpected report shape.');
  }
  let count = 0;
  for (const result of results) {
    if (typeof result !== 'object' || result === null || !('packages' in result)) {
      throw new TypeError('OSV-Scanner returned an unexpected report shape.');
    }
    const { packages } = result;
    if (!Array.isArray(packages)) {
      throw new TypeError('OSV-Scanner returned an unexpected report shape.');
    }
    for (const packageResult of packages) {
      if (
        typeof packageResult !== 'object' ||
        packageResult === null ||
        !('vulnerabilities' in packageResult) ||
        !Array.isArray(packageResult.vulnerabilities)
      ) {
        throw new TypeError('OSV-Scanner returned an unexpected report shape.');
      }
      if (
        packageResult.vulnerabilities.some(
          (vulnerability) =>
            typeof vulnerability !== 'object' ||
            vulnerability === null ||
            !('id' in vulnerability) ||
            typeof vulnerability.id !== 'string' ||
            !vulnerability.id
        )
      ) {
        throw new TypeError('OSV-Scanner returned an unexpected report shape.');
      }
      count += packageResult.vulnerabilities.length;
    }
  }
  return count;
}

export interface OsvRoutingEnvironment {
  GITHUB_REPOSITORY?: string;
  GITHUB_RUN_ID?: string;
  GITHUB_SHA?: string;
  SAM_OSV_WEBHOOK_TOKEN?: string;
  SAM_OSV_WEBHOOK_URL?: string;
}

export interface OsvRoutingRequest {
  body: string;
  headers: Record<string, string>;
  url: URL;
}

function isPrivateHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (normalized === 'localhost' || normalized.endsWith('.localhost')) return true;
  if (
    normalized.includes(':') &&
    (normalized === '::1' ||
      normalized.startsWith('fc') ||
      normalized.startsWith('fd') ||
      normalized.startsWith('fe8') ||
      normalized.startsWith('fe9'))
  )
    return true;
  const octets = normalized.split('.').map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet))) return false;
  const secondOctet = octets[1] ?? -1;
  return (
    octets[0] === 0 ||
    octets[0] === 10 ||
    octets[0] === 127 ||
    (octets[0] === 169 && secondOctet === 254) ||
    (octets[0] === 172 && secondOctet >= 16 && secondOctet <= 31) ||
    (octets[0] === 192 && secondOctet === 168)
  );
}

export function createPrivateFollowUpRequest(
  count: number,
  environment: OsvRoutingEnvironment
): OsvRoutingRequest {
  const webhookUrl = environment.SAM_OSV_WEBHOOK_URL;
  const webhookToken = environment.SAM_OSV_WEBHOOK_TOKEN;
  if (!webhookUrl || !webhookToken) {
    throw new Error('Private SAM OSV routing is not configured.');
  }
  const parsedUrl = new URL(webhookUrl);
  if (parsedUrl.protocol !== 'https:') throw new Error('Private SAM OSV routing must use HTTPS.');
  if (parsedUrl.username || parsedUrl.password || isPrivateHostname(parsedUrl.hostname)) {
    throw new Error('Private SAM OSV routing URL is not permitted.');
  }
  const commitSha = environment.GITHUB_SHA;
  const runId = environment.GITHUB_RUN_ID;
  const repository = environment.GITHUB_REPOSITORY;
  if (!commitSha || !/^[a-f0-9]{40,64}$/.test(commitSha)) {
    throw new Error('Private SAM OSV routing requires a valid GitHub revision.');
  }
  if (!runId || !/^\d+$/.test(runId)) {
    throw new Error('Private SAM OSV routing requires a valid GitHub run id.');
  }
  if (!repository || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error('Private SAM OSV routing requires a valid repository identifier.');
  }
  if (!Number.isSafeInteger(count) || count <= 0) {
    throw new Error('Private SAM OSV routing requires a positive finding count.');
  }
  return {
    url: parsedUrl,
    headers: {
      Authorization: `Bearer ${webhookToken}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': `osv-${commitSha}-${runId}`,
    },
    body: JSON.stringify({
      findingCount: count,
      owner: 'security',
      repository,
      revision: commitSha,
      source: 'scheduled-osv',
      summary: 'Create or update owned private SAM backlog follow-up for the scheduled OSV scan.',
    }),
  };
}

async function routePrivateFollowUp(count: number): Promise<void> {
  const request = createPrivateFollowUpRequest(count, process.env);
  const response = await fetch(request.url, {
    method: 'POST',
    headers: request.headers,
    body: request.body,
    redirect: 'error',
  });
  if (!response.ok) throw new TypeError('Private SAM OSV routing rejected the advisory.');
}

async function run(): Promise<void> {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'sam-osv-'));
  const reportPath = join(temporaryDirectory, 'report.json');
  try {
    const result = spawnSync(
      process.env.SAM_OSV_SCANNER_BIN ?? '/usr/local/bin/osv-scanner',
      [
        'scan',
        'source',
        '--recursive',
        '--format=json',
        '--verbosity=error',
        '--config',
        resolve(repoRoot, 'osv-scanner.toml'),
        '--output-file',
        reportPath,
        repoRoot,
      ],
      { cwd: repoRoot, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }
    );
    if (result.error || (result.status !== 0 && result.status !== 1)) {
      throw new TypeError('OSV-Scanner could not complete; scanner output is withheld.');
    }
    const report = JSON.parse(readFileSync(reportPath, 'utf8')) as unknown;
    const findingCount = countOsvVulnerabilities(report);
    if (findingCount === 0) {
      console.log('Scheduled OSV scan passed with no advisory findings.');
      return;
    }
    await routePrivateFollowUp(findingCount);
    console.log(`Scheduled OSV scan routed ${findingCount} finding(s) to private SAM follow-up.`);
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

const isDirectExecution =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectExecution) await run();
