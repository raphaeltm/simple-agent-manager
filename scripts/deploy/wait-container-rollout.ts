import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { stripVTControlCharacters } from 'node:util';

import { parse } from '@iarna/toml';

import {
  createRolloutApi,
  parseSnapshot,
  readRolloutTiming,
  snapshotApplications,
  waitForContainerRollouts,
} from './container-rollout';

/** Match Wrangler's default naming, including its environment suffix. */
export function containerApplicationNames(
  config: string,
  worker: string,
  environment: string
): string[] {
  const containers = parse(config).containers;
  if (!Array.isArray(containers) || !containers.length)
    throw new Error('No readable container definitions');
  return containers.map((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('Unreadable container definition');
    const item = value as Record<string, unknown>;
    if (typeof item.name === 'string' && item.name) return item.name;
    if (typeof item.class_name !== 'string' || !item.class_name)
      throw new Error('Container class_name missing');
    return `${worker}-${item.class_name}-${environment}`.toLowerCase().replaceAll(' ', '-');
  });
}
async function main() {
  const [mode, file] = process.argv.slice(2);
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!account || !token || !file || !['snapshot', 'wait'].includes(mode))
    throw new Error('Expected snapshot|wait <file> with Cloudflare account/token');
  const timing = readRolloutTiming(process.env);
  const api = createRolloutApi(account, token, AbortSignal.timeout(timing.timeoutMs));
  if (mode === 'snapshot') {
    const worker = process.env.API_WORKER_NAME;
    const environment = process.env.DEPLOY_ENV;
    if (!worker || !environment) throw new Error('API_WORKER_NAME and DEPLOY_ENV required');
    const names = containerApplicationNames(
      readFileSync('apps/api/wrangler.toml', 'utf8'),
      worker,
      environment
    );
    writeFileSync(file, JSON.stringify(await snapshotApplications(api, names)));
  } else {
    const before = parseSnapshot(JSON.parse(readFileSync(file, 'utf8')) as unknown);
    const outputFile = process.env.CONTAINER_DEPLOY_OUTPUT;
    const output = outputFile ? stripVTControlCharacters(readFileSync(outputFile, 'utf8')) : '';
    const modifiedNames = new Set(
      [...output.matchAll(/Modified application ([^\n]+?) \(Application ID:/g)].map((m) => m[1])
    );
    await waitForContainerRollouts(api, before, { ...timing, modifiedNames });
  }
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : 'Container rollout gate failed');
    process.exitCode = 1;
  });
}
