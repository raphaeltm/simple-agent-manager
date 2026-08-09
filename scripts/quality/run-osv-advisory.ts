import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function countOsvVulnerabilities(report: unknown): number {
  if (Array.isArray(report))
    return report.reduce((total, item) => total + countOsvVulnerabilities(item), 0);
  if (typeof report !== 'object' || report === null) return 0;
  let count = 0;
  for (const [key, value] of Object.entries(report)) {
    if (key === 'vulnerabilities' && Array.isArray(value)) count += value.length;
    else count += countOsvVulnerabilities(value);
  }
  return count;
}

async function routePrivateFollowUp(count: number): Promise<void> {
  const webhookUrl = process.env.SAM_OSV_WEBHOOK_URL;
  const webhookToken = process.env.SAM_OSV_WEBHOOK_TOKEN;
  if (!webhookUrl || !webhookToken) {
    throw new Error('Private SAM OSV routing is not configured.');
  }
  const parsedUrl = new URL(webhookUrl);
  if (parsedUrl.protocol !== 'https:') throw new Error('Private SAM OSV routing must use HTTPS.');
  const commitSha = process.env.GITHUB_SHA ?? 'local';
  const response = await fetch(parsedUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${webhookToken}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': `osv-${commitSha}`,
    },
    body: JSON.stringify({
      findingCount: count,
      owner: 'security',
      repository: process.env.GITHUB_REPOSITORY ?? 'raphaeltm/simple-agent-manager',
      revision: commitSha,
      source: 'scheduled-osv',
      summary: 'Create or update owned private SAM backlog follow-up for the scheduled OSV scan.',
    }),
  });
  if (!response.ok) throw new Error('Private SAM OSV routing rejected the advisory.');
}

async function run(): Promise<void> {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'sam-osv-'));
  const reportPath = join(temporaryDirectory, 'report.json');
  try {
    const result = spawnSync(
      'osv-scanner',
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
      throw new Error('OSV-Scanner could not complete; scanner output is withheld.');
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
