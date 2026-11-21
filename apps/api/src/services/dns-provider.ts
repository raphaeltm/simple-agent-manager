/**
 * DNS provider seam: where this installation's DNS records live.
 *
 * On Cloudflare nothing is installed here, so every DNS function in `dns-core.ts`,
 * `dns-app-routes.ts`, `dns-node-backend.ts` and `dns-workspace.ts` calls the Cloudflare DNS API
 * exactly as before: same requests, same records, no extra I/O (the check below is in memory).
 *
 * Only the self-host build installs a box backend (`apps/api/src/selfhost/dns/`, records in the
 * box's D1, served by the sam-dns sidecar). The shared Worker entry never imports that module, so
 * the Cloudflare bundle does not contain it, and a Cloudflare Worker that happens to carry the
 * box's `SAM_DNS_PROVIDER` var still resolves to Cloudflare
 * (tests/unit/services/dns-provider.test.ts).
 */
import type { Env } from '../env';

/** One stored A record, in the shape the Cloudflare lookups return. */
export interface BoxDnsRecordMatch {
  id: string;
  name: string;
  type: string;
  content?: string;
  proxied?: boolean;
}

export interface BoxDnsBackend {
  /** Whether this installation keeps its records on the box. Pure: no I/O. */
  active(env: Env): boolean;
  /**
   * Creates or replaces the A record for `name` (a name inside the zone, or relative to it, as the
   * Cloudflare API accepts) and returns its id.
   */
  upsertARecord(name: string, ip: string, env: Env): Promise<string>;
  /**
   * Creates the A record for `name` only if none exists; returns its id, or null when another
   * caller's record is already there (the durable replay then checks that record's identity).
   */
  insertARecordIfAbsent(name: string, ip: string, env: Env): Promise<string | null>;
  /** Points an existing record at `ip`. A missing id is an error, as Cloudflare's PATCH is. */
  updateRecordContent(id: string, ip: string, env: Env): Promise<void>;
  /** Deletes a record by id; a missing id is success (Cloudflare's 404 is ignored too). */
  deleteRecord(id: string, env: Env): Promise<void>;
  /** Every A record with this name. */
  findARecordsByName(name: string, env: Env): Promise<BoxDnsRecordMatch[]>;
  /** Deletes every record (any type) with this name; returns how many. */
  deleteRecordsByName(name: string, env: Env): Promise<number>;
}

let backend: BoxDnsBackend | undefined;

/** Called once by the self-host entry, before any request runs. */
export function installBoxDnsBackend(value: BoxDnsBackend): void {
  if (backend && backend !== value) throw new Error('A box DNS backend is already installed');
  backend = value;
}

/** Test seam: back to the Cloudflare state (nothing installed). */
export function resetBoxDnsBackendForTests(): void {
  backend = undefined;
}

/** The box backend when it serves this installation's records, else undefined (Cloudflare). */
export function boxDnsBackendFor(env: Env): BoxDnsBackend | undefined {
  return backend?.active(env) ? backend : undefined;
}

/** Which DNS provider this installation uses. Pure: no I/O. */
export function resolveDnsProvider(env: Env): 'cloudflare' | 'box' {
  return boxDnsBackendFor(env) ? 'box' : 'cloudflare';
}
