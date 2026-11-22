/**
 * The self-host build's DNS provider: the box answers for BASE_DOMAIN itself (sam-dns sidecar,
 * deploy/selfhost/sam-dns), so records the Worker writes go to the box's D1 instead of the
 * Cloudflare DNS API. Imported only by the self-host entry (`selfhost/build.ts`), which calls
 * `installBoxDns()` once before any request; the shared Worker entry never imports this directory,
 * so the Cloudflare bundle does not contain it.
 *
 * Active only when the deployment also sets `SAM_DNS_PROVIDER="box"`. Nothing sets it yet: the box
 * deploy will write it together with the sam-dns sidecar (task 2026-11-21-selfhost-box-dns, PR b).
 * A box without it keeps calling Cloudflare, exactly as before, so an existing box changes nothing
 * until its operator switches.
 */
import type { Env } from '../../env';
import { type BoxDnsBackend, installBoxDnsBackend } from '../../services/dns-provider';
import {
  deleteBoxRecord,
  deleteBoxRecordsByName,
  findBoxARecordsByName,
  insertBoxARecordIfAbsent,
  updateBoxRecordContent,
  upsertBoxARecord,
} from './records';

/** Self-host bootstrap setting; never a Cloudflare Worker binding (as reverse-tunnel/env.ts). */
export interface BoxDnsSettingsEnv extends Env {
  /** "box": records go to the box's own zone. Unset or anything else: Cloudflare DNS. */
  SAM_DNS_PROVIDER?: string;
  /**
   * The box's public IPv4 address (the parent zone's glue record), the same value sam-dns serves
   * for the box's own names. App-route records for deployment nodes on the reverse tunnel point
   * at it: their app traffic enters through the box (`reverse-tunnel/app-route.ts`).
   */
  SAM_DNS_PUBLIC_IPV4?: string;
}

const IPV4_RE = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

/** The box's public IPv4 address, or null when it is unset or not an IPv4 address. Pure. */
export function boxPublicIPv4(env: Env): string | null {
  const value = (env as BoxDnsSettingsEnv).SAM_DNS_PUBLIC_IPV4?.trim() ?? '';
  return IPV4_RE.test(value) ? value : null;
}

/** Whether this box serves its own DNS zone. Pure: no I/O. */
export function isBoxDnsEnabled(env: Env): boolean {
  const provider = (env as BoxDnsSettingsEnv).SAM_DNS_PROVIDER;
  return provider?.trim().toLowerCase() === 'box' && !!env.DATABASE;
}

export const boxDnsBackend: BoxDnsBackend = {
  active: (env) => isBoxDnsEnabled(env),
  upsertARecord: (name, ip, env) => upsertBoxARecord(name, ip, env),
  insertARecordIfAbsent: (name, ip, env) => insertBoxARecordIfAbsent(name, ip, env),
  updateRecordContent: (id, ip, env) => updateBoxRecordContent(id, ip, env),
  deleteRecord: (id, env) => deleteBoxRecord(id, env),
  findARecordsByName: (name, env) => findBoxARecordsByName(name, env),
  deleteRecordsByName: (name, env) => deleteBoxRecordsByName(name, env),
};

/** Registers the box DNS backend. Idempotent; call before any request. */
export function installBoxDns(): void {
  installBoxDnsBackend(boxDnsBackend);
}
