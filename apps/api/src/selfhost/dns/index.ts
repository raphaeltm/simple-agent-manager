/**
 * The self-host build's DNS provider: the box answers for BASE_DOMAIN itself (sam-dns sidecar,
 * deploy/selfhost/sam-dns), so records the Worker writes go to the box's D1 instead of the
 * Cloudflare DNS API. Imported only by the self-host entry (`selfhost/build.ts`), which calls
 * `installBoxDns()` once before any request; the shared Worker entry never imports this directory,
 * so the Cloudflare bundle does not contain it.
 *
 * Active only when the deployment also sets `SAM_DNS_PROVIDER="box"` (the box deploy writes it when
 * `.env` says so, scripts/selfhost/box-settings.ts). A box without it keeps calling Cloudflare,
 * exactly as before, so an existing box changes nothing until its operator switches.
 */
import type { Env } from '../../env';
import { type BoxDnsBackend, installBoxDnsBackend } from '../../services/dns-provider';
import {
  deleteBoxRecord,
  deleteBoxRecordsByName,
  findBoxARecordsByName,
  updateBoxRecordContent,
  upsertBoxARecord,
} from './records';

/** Self-host bootstrap setting; never a Cloudflare Worker binding (as reverse-tunnel/env.ts). */
export interface BoxDnsSettingsEnv extends Env {
  /** "box": records go to the box's own zone. Unset or anything else: Cloudflare DNS. */
  SAM_DNS_PROVIDER?: string;
}

/** Whether this box serves its own DNS zone. Pure: no I/O. */
export function isBoxDnsEnabled(env: Env): boolean {
  const provider = (env as BoxDnsSettingsEnv).SAM_DNS_PROVIDER;
  return provider?.trim().toLowerCase() === 'box' && !!env.DATABASE;
}

export const boxDnsBackend: BoxDnsBackend = {
  active: (env) => isBoxDnsEnabled(env),
  upsertARecord: (name, ip, env) => upsertBoxARecord(name, ip, env),
  updateRecordContent: (id, ip, env) => updateBoxRecordContent(id, ip, env),
  deleteRecord: (id, env) => deleteBoxRecord(id, env),
  findARecordsByName: (name, env) => findBoxARecordsByName(name, env),
  deleteRecordsByName: (name, env) => deleteBoxRecordsByName(name, env),
};

/** Registers the box DNS backend. Idempotent; call before any request. */
export function installBoxDns(): void {
  installBoxDnsBackend(boxDnsBackend);
}
