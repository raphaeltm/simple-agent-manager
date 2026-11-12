/**
 * Which cloud this box runs on, from the instance metadata services themselves (never from host
 * names or DNS suffixes). The three probes run in parallel, each with a short timeout, and a
 * platform counts only when its answer carries that platform's own marker:
 *
 * - Google Compute Engine: `GET /computeMetadata/v1/project/project-id` with
 *   `Metadata-Flavor: Google`; the answer must carry the `Metadata-Flavor: Google` header.
 * - AWS EC2, IMDSv2 only: `PUT /latest/api/token`, then the instance identity document with that
 *   token; the document must name a region and an account.
 * - Azure: `GET /metadata/instance/compute?api-version=2021-02-01` with `Metadata: true`; the
 *   answer must name a VM id and a subscription.
 *
 * Other clouds' metadata services (and anything else on 169.254.169.254) fail those markers.
 *
 * A metadata answer alone is not trusted: on a host outside the cloud, anything on the local
 * network can answer 169.254.169.254 with a project or account it controls, and a round trip
 * against its own key would pass, sealing the box's secrets to that key. So the machine's own
 * firmware identity (DMI, /sys/class/dmi/id, which the network cannot forge) must name the same
 * platform; a metadata answer it does not back is ignored and reported.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Per-probe bound; detection never delays `--init` by more than this. */
export const DEFAULT_METADATA_PROBE_TIMEOUT_MS = 1500;
const LINK_LOCAL = '169.254.169.254';
/** Larger answers are not what the probes ask for. */
const MAX_ANSWER_BYTES = 64 * 1024;

export type PlatformFacts =
  | { platform: 'gcp'; projectId: string }
  | { platform: 'aws'; region: string; accountId: string }
  | { platform: 'azure'; location: string; subscriptionId: string };

export interface ProbeResult {
  facts: PlatformFacts | null;
  /** One short line per platform that did not answer as itself, for diagnostics. */
  misses: string[];
}

type Box = Readonly<Record<string, string | undefined>>;

function probeTimeout(box: Box): number {
  const raw = Number(box.SAM_METADATA_PROBE_TIMEOUT_MS);
  return Number.isInteger(raw) && raw > 0 && raw <= 30_000
    ? raw
    : DEFAULT_METADATA_PROBE_TIMEOUT_MS;
}

/** Host (and optional port) of a metadata service: an override for tests, else the link-local address. */
function host(box: Box, name: string): string {
  const value = box[name]?.trim();
  if (!value) return LINK_LOCAL;
  if (!/^[A-Za-z0-9.-]+(:\d{1,5})?$/.test(value) && !/^\[[0-9a-fA-F:]+\](:\d{1,5})?$/.test(value)) {
    throw new Error(`${name} must be a host or host:port`);
  }
  return value;
}

async function boundedText(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_ANSWER_BYTES) {
      await reader.cancel();
      throw new Error('answer too large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function call(
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<{ response: Response; text: string }> {
  const response = await fetch(url, {
    ...init,
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs),
  });
  return { response, text: await boundedText(response) };
}

function reason(error: unknown): string {
  if (error instanceof Error) {
    return error.name === 'TimeoutError' ? 'no answer in time' : error.message.slice(0, 120);
  }
  return String(error).slice(0, 120);
}

function asRecord(text: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(text) as unknown;
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

async function probeGce(box: Box, timeoutMs: number): Promise<PlatformFacts> {
  const { response, text } = await call(
    `http://${host(box, 'SAM_GCE_METADATA_HOST')}/computeMetadata/v1/project/project-id`,
    { headers: { 'Metadata-Flavor': 'Google' } },
    timeoutMs
  );
  if (!response.ok || response.headers.get('metadata-flavor') !== 'Google') {
    throw new Error(`HTTP ${response.status} without the Google metadata marker`);
  }
  const projectId = text.trim();
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(projectId)) throw new Error('no project id');
  return { platform: 'gcp', projectId };
}

async function probeAws(box: Box, timeoutMs: number): Promise<PlatformFacts> {
  const base = `http://${host(box, 'SAM_AWS_IMDS_HOST')}`;
  const token = await call(
    `${base}/latest/api/token`,
    { method: 'PUT', headers: { 'X-aws-ec2-metadata-token-ttl-seconds': '60' } },
    timeoutMs
  );
  if (!token.response.ok || !token.text.trim()) {
    throw new Error(`IMDSv2 token: HTTP ${token.response.status}`);
  }
  const doc = await call(
    `${base}/latest/dynamic/instance-identity/document`,
    { headers: { 'X-aws-ec2-metadata-token': token.text.trim() } },
    timeoutMs
  );
  const record = doc.response.ok ? asRecord(doc.text) : null;
  const region = record?.region;
  const accountId = record?.accountId;
  if (
    typeof region !== 'string' ||
    !/^[a-z]{2}(-[a-z]+)+-\d+$/.test(region) ||
    typeof accountId !== 'string' ||
    !/^\d{12}$/.test(accountId)
  ) {
    throw new Error(`identity document: HTTP ${doc.response.status} without region and account`);
  }
  return { platform: 'aws', region, accountId };
}

async function probeAzure(box: Box, timeoutMs: number): Promise<PlatformFacts> {
  const { response, text } = await call(
    `http://${host(box, 'SAM_AZURE_IMDS_HOST')}/metadata/instance/compute?api-version=2021-02-01`,
    { headers: { Metadata: 'true' } },
    timeoutMs
  );
  const record = response.ok ? asRecord(text) : null;
  const location = record?.location;
  const subscriptionId = record?.subscriptionId;
  if (
    typeof record?.vmId !== 'string' ||
    typeof location !== 'string' ||
    typeof subscriptionId !== 'string' ||
    !/^[0-9a-f-]{36}$/i.test(subscriptionId)
  ) {
    throw new Error(`HTTP ${response.status} without vmId and subscription`);
  }
  return { platform: 'azure', location, subscriptionId };
}

/** Azure's documented fixed chassis asset tag for its VMs. */
const AZURE_ASSET_TAG = '7783-7084-3265-9085-8269-3286-77';

/** The platform the machine's DMI identity names, or null. `SAM_DMI_DIR` exists for tests. */
export function dmiPlatform(box: Box): PlatformFacts['platform'] | null {
  const dir = box.SAM_DMI_DIR?.trim() || '/sys/class/dmi/id';
  const read = (name: string) => {
    try {
      return readFileSync(join(dir, name), 'utf8').trim();
    } catch {
      return '';
    }
  };
  if (read('product_name') === 'Google Compute Engine' || read('sys_vendor') === 'Google') {
    return 'gcp';
  }
  const amazon = ['sys_vendor', 'bios_vendor', 'product_version', 'bios_version']
    .map(read)
    .join(' ')
    .toLowerCase();
  if (amazon.includes('amazon')) return 'aws';
  if (
    read('sys_vendor') === 'Microsoft Corporation' &&
    read('chassis_asset_tag') === AZURE_ASSET_TAG
  ) {
    return 'azure';
  }
  return null;
}

/** Probes Google, AWS and Azure at once; at most one answers as itself. */
export async function probePlatform(box: Box): Promise<ProbeResult> {
  const timeoutMs = probeTimeout(box);
  const probes = [
    ['Google Cloud', probeGce],
    ['AWS', probeAws],
    ['Azure', probeAzure],
  ] as const;
  const settled = await Promise.allSettled(probes.map(([, probe]) => probe(box, timeoutMs)));
  const misses: string[] = [];
  let facts: PlatformFacts | null = null;
  const machine = dmiPlatform(box);
  settled.forEach((outcome, index) => {
    const name = probes[index]?.[0] ?? '';
    if (outcome.status !== 'fulfilled') {
      misses.push(`${name}: ${reason(outcome.reason)}`);
    } else if (outcome.value.platform !== machine) {
      misses.push(
        `${name}: a metadata answer this machine's firmware (DMI) does not back; ignored`
      );
    } else {
      facts ??= outcome.value;
    }
  });
  return { facts, misses };
}

export function platformName(facts: PlatformFacts): string {
  if (facts.platform === 'gcp') return `Google Cloud (project ${facts.projectId})`;
  if (facts.platform === 'aws') return `AWS (${facts.region})`;
  return `Azure (${facts.location})`;
}
