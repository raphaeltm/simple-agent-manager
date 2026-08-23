import type { ImageResolverConfig, ImageResolverDnsLookupFn } from './image-resolver';

export const DEFAULT_IMAGE_RESOLVE_DNS_LOOKUP_TIMEOUT_MS = 10_000;
export const DEFAULT_IMAGE_RESOLVE_MAX_DNS_LOOKUPS = 400;
export const DEFAULT_IMAGE_RESOLVE_DNS_RESPONSE_MAX_BYTES = 32_768;
export const DEFAULT_IMAGE_RESOLVE_DOH_RESOLVER_URL = 'https://cloudflare-dns.com/dns-query';

const DNS_TYPE_A = 1;
const DNS_TYPE_AAAA = 28;

interface DnsPreflightBudget {
  dnsLookups: number;
  deadlineAt: number | null;
}

export interface DnsPreflightRuntime {
  dnsLookupFn: ImageResolverDnsLookupFn;
  config: ImageResolverConfig;
  budget: DnsPreflightBudget;
}

export function isBlockedHostname(hostname: string): boolean {
  if (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname === 'metadata' ||
    hostname.endsWith('.metadata') ||
    hostname === 'metadata.google.internal' ||
    hostname === 'metadata.azure.internal' ||
    hostname === 'instance-data' ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.localdomain') ||
    hostname.endsWith('.internal')
  ) {
    return true;
  }

  const ipv4 = parseIpv4(hostname);
  if (ipv4) {
    return isUnsafeIpv4(ipv4);
  }

  const ipv6 = parseIpv6(hostname);
  return ipv6 ? isUnsafeIpv6(ipv6) : false;
}

function isIpLiteral(hostname: string): boolean {
  return parseIpv4(hostname) !== null || parseIpv6(hostname) !== null;
}

function parseIpv4(hostname: string): [number, number, number, number] | null {
  const parts = hostname.split('.');
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => {
    if (!/^\d{1,3}$/.test(part)) return null;
    const value = Number(part);
    return Number.isInteger(value) && value >= 0 && value <= 255 ? value : null;
  });
  if (octets.some((part) => part === null)) return null;
  return octets as [number, number, number, number];
}

function isUnsafeIpv4([a, b, c, d]: [number, number, number, number]): boolean {
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224 ||
    (a === 255 && b === 255 && c === 255 && d === 255)
  );
}

function parseIpv6(hostname: string): number[] | null {
  const host = hostname.replace(/^\[/, '').replace(/\]$/, '').toLowerCase();
  if (!host.includes(':') || host.includes('%')) return null;
  const halves = host.split('::');
  if (halves.length > 2) return null;

  const head = parseIpv6Words(halves[0] ?? '');
  const tail = parseIpv6Words(halves[1] ?? '');
  if (!head || !tail) return null;
  if (halves.length === 1 && head.length !== 8) return null;
  if (halves.length === 2 && head.length + tail.length >= 8) return null;

  const zeros = new Array(8 - head.length - tail.length).fill(0) as number[];
  const words = [...head, ...zeros, ...tail];
  if (words.length !== 8) return null;

  const bytes: number[] = [];
  for (const word of words) {
    bytes.push((word >> 8) & 0xff, word & 0xff);
  }
  return bytes;
}

function parseIpv6Words(part: string): number[] | null {
  if (!part) return [];
  const pieces = part.split(':');
  const words: number[] = [];
  for (const piece of pieces) {
    if (!piece) return null;
    if (piece.includes('.')) {
      const ipv4 = parseIpv4(piece);
      if (!ipv4) return null;
      words.push((ipv4[0] << 8) | ipv4[1], (ipv4[2] << 8) | ipv4[3]);
      continue;
    }
    if (!/^[0-9a-f]{1,4}$/i.test(piece)) return null;
    words.push(Number.parseInt(piece, 16));
  }
  return words;
}

function isUnsafeIpv6(bytes: number[]): boolean {
  if (bytes.length !== 16) return true;
  const first = bytes[0] ?? 0;
  const second = bytes[1] ?? 0;
  const isUnspecified = bytes.every((byte) => byte === 0);
  const isLoopback = bytes.slice(0, 15).every((byte) => byte === 0) && bytes[15] === 1;
  const isUniqueLocal = (first & 0xfe) === 0xfc;
  const isLinkLocal = first === 0xfe && (second & 0xc0) === 0x80;
  const isDeprecatedSiteLocal = first === 0xfe && (second & 0xc0) === 0xc0;
  const isMulticast = first === 0xff;
  const isIpv4Mapped =
    bytes.slice(0, 10).every((byte) => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff;
  const isIpv4Compatible =
    bytes.slice(0, 12).every((byte) => byte === 0) && !bytes.slice(12).every((byte) => byte === 0);
  const embeddedIpv4 =
    isIpv4Mapped || isIpv4Compatible
      ? ([bytes[12], bytes[13], bytes[14], bytes[15]] as [number, number, number, number])
      : null;

  return (
    isUnspecified ||
    isLoopback ||
    isUniqueLocal ||
    isLinkLocal ||
    isDeprecatedSiteLocal ||
    isMulticast ||
    (embeddedIpv4 !== null && isUnsafeIpv4(embeddedIpv4))
  );
}

function remainingDnsTimeoutMs(config: ImageResolverConfig, budget: DnsPreflightBudget): number {
  const now = Date.now();
  if (budget.deadlineAt === null) {
    budget.deadlineAt = now + config.totalTimeoutMs;
  }
  const remaining = budget.deadlineAt - now;
  if (remaining <= 0) {
    throw new Error(`Image resolution exceeded total time budget of ${config.totalTimeoutMs}ms.`);
  }
  return Math.max(1, Math.min(config.dnsLookupTimeoutMs, remaining));
}

function assertSafeResolvedAddress(address: string, hostname: string, kind: string): void {
  const normalized = address.trim().replace(/^\[/, '').replace(/\]$/, '').toLowerCase();
  const ipv4 = parseIpv4(normalized);
  if (ipv4) {
    if (isUnsafeIpv4(ipv4)) {
      throw new Error(
        `Unsafe ${kind} URL rejected: DNS for host ${hostname} resolved to non-public address ${address}.`
      );
    }
    return;
  }

  const ipv6 = parseIpv6(normalized);
  if (ipv6) {
    if (isUnsafeIpv6(ipv6)) {
      throw new Error(
        `Unsafe ${kind} URL rejected: DNS for host ${hostname} resolved to non-public address ${address}.`
      );
    }
    return;
  }

  throw new Error(
    `Unsafe ${kind} URL rejected: DNS for host ${hostname} returned an invalid address.`
  );
}

export async function assertResolvedPublic(
  url: URL,
  runtime: DnsPreflightRuntime,
  kind: string
): Promise<void> {
  const hostname = url.hostname.replace(/^\[/, '').replace(/\]$/, '').toLowerCase();
  if (isIpLiteral(hostname)) return;

  const { config, budget } = runtime;
  if (budget.dnsLookups >= config.maxDnsLookups) {
    throw new Error(`Image resolution exceeded DNS lookup budget of ${config.maxDnsLookups}.`);
  }

  const timeoutMs = remainingDnsTimeoutMs(config, budget);
  budget.dnsLookups += 1;

  let addresses: string[];
  try {
    addresses = await runtime.dnsLookupFn(hostname, AbortSignal.timeout(timeoutMs));
  } catch (err) {
    if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
      throw new Error(`Image resolver DNS lookup timed out after ${timeoutMs}ms.`);
    }
    throw new Error(
      `Unsafe ${kind} URL rejected: DNS lookup failed for host ${hostname}: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }

  if (addresses.length === 0) {
    throw new Error(
      `Unsafe ${kind} URL rejected: DNS for host ${hostname} returned no public addresses.`
    );
  }
  for (const address of addresses) {
    assertSafeResolvedAddress(address, hostname, kind);
  }
}

async function readDnsTextBounded(response: Response, maxBytes: number): Promise<string> {
  const contentLength = response.headers.get('content-length');
  if (contentLength) {
    const parsed = Number.parseInt(contentLength, 10);
    if (Number.isFinite(parsed) && parsed > maxBytes) {
      throw new Error(`DNS lookup response exceeded ${maxBytes} bytes.`);
    }
  }

  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > maxBytes) {
    throw new Error(`DNS lookup response exceeded ${maxBytes} bytes.`);
  }
  return text;
}

function dohLookupUrl(resolverUrl: URL, hostname: string, recordType: 'A' | 'AAAA'): string {
  const url = new URL(resolverUrl);
  url.searchParams.set('name', hostname);
  url.searchParams.set('type', recordType);
  return url.toString();
}

async function fetchDohAddresses(
  resolverUrl: URL,
  hostname: string,
  recordType: 'A' | 'AAAA',
  fetchFn: typeof fetch,
  signal: AbortSignal,
  maxBytes: number
): Promise<string[]> {
  const response = await fetchFn(dohLookupUrl(resolverUrl, hostname, recordType), {
    headers: { accept: 'application/dns-json' },
    signal,
  });
  if (!response.ok) {
    throw new Error(`DoH lookup failed with HTTP ${response.status}.`);
  }

  const parsed = JSON.parse(await readDnsTextBounded(response, maxBytes)) as unknown;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('DoH lookup returned an invalid response.');
  }
  const body = parsed as Record<string, unknown>;
  if (typeof body.Status !== 'number') {
    throw new Error('DoH lookup returned an invalid response.');
  }
  if (body.Status !== 0 && body.Status !== 3) {
    throw new Error(`DoH lookup returned DNS status ${body.Status}.`);
  }
  if (!Array.isArray(body.Answer)) return [];

  const expectedType = recordType === 'A' ? DNS_TYPE_A : DNS_TYPE_AAAA;
  const addresses: string[] = [];
  for (const answer of body.Answer) {
    if (typeof answer !== 'object' || answer === null) continue;
    const record = answer as Record<string, unknown>;
    if (record['type'] === expectedType && typeof record['data'] === 'string') {
      addresses.push(record['data']);
    }
  }
  return addresses;
}

function validateDohResolverUrl(input: string): URL {
  const url = new URL(input);
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error('Unsafe DNS resolver URL rejected: HTTPS without userinfo is required.');
  }
  const hostname = url.hostname.replace(/^\[/, '').replace(/\]$/, '').toLowerCase();
  if (!hostname || hostname.endsWith('.') || hostname.includes('%') || isBlockedHostname(hostname)) {
    throw new Error('Unsafe DNS resolver URL rejected: resolver host is not public-safe.');
  }
  return url;
}

export function createDohDnsLookup(
  fetchFn: typeof fetch,
  config: ImageResolverConfig
): ImageResolverDnsLookupFn {
  const resolverUrl = validateDohResolverUrl(config.dohResolverUrl);
  return async (hostname: string, signal: AbortSignal): Promise<string[]> => {
    const [a, aaaa] = await Promise.all([
      fetchDohAddresses(
        resolverUrl,
        hostname,
        'A',
        fetchFn,
        signal,
        config.dnsResponseMaxBytes
      ),
      fetchDohAddresses(
        resolverUrl,
        hostname,
        'AAAA',
        fetchFn,
        signal,
        config.dnsResponseMaxBytes
      ),
    ]);
    return [...a, ...aaaa];
  };
}
