#!/usr/bin/env node
/**
 * Resolve a secondary installation's Cloudflare zone ID from its domain, so the installation
 * needs no CF_ZONE_ID secret of its own. With --workers-subdomain it also reads the account's
 * existing workers.dev subdomain (read only: the subdomain is account-wide, and changing it
 * would break every other installation in the account).
 *
 * Fails closed: exactly one active zone with that exact name in this account, or exit 1.
 */
import { appendFileSync } from 'node:fs';

const API = 'https://api.cloudflare.com/client/v4';

async function cloudflare(path, token, fetchImpl) {
  const response = await fetchImpl(`${API}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.success) {
    const message = body?.errors?.map((e) => e.message).join('; ') || `HTTP ${response.status}`;
    throw new Error(`Cloudflare ${path.split('?')[0]} failed: ${message}`);
  }
  return body.result;
}

export async function resolveInstallationZone({
  zoneName,
  accountId,
  token,
  withWorkersSubdomain = false,
  fetchImpl = fetch,
}) {
  if (!zoneName || !accountId || !token) {
    throw new Error('ZONE_NAME, CF_ACCOUNT_ID and CF_API_TOKEN are required.');
  }
  const query = new URLSearchParams({ name: zoneName, 'account.id': accountId });
  const zones = await cloudflare(`/zones?${query}`, token, fetchImpl);
  const matches = (Array.isArray(zones) ? zones : []).filter(
    (zone) => zone?.name === zoneName && zone?.account?.id === accountId
  );
  if (matches.length !== 1) {
    throw new Error(
      `Expected one zone named ${zoneName} in this account, found ${matches.length}. Add the zone to the account and give the deploy token access to it.`
    );
  }
  if (matches[0].status !== 'active') {
    throw new Error(`Zone ${zoneName} is ${matches[0].status}, not active.`);
  }
  const outputs = { zone_id: matches[0].id };
  if (withWorkersSubdomain) {
    const subdomain = await cloudflare(
      `/accounts/${encodeURIComponent(accountId)}/workers/subdomain`,
      token,
      fetchImpl
    );
    if (typeof subdomain?.subdomain !== 'string' || subdomain.subdomain === '') {
      throw new Error(
        'The account has no workers.dev subdomain; deploy the primary installation first.'
      );
    }
    outputs.workers_dev_subdomain = subdomain.subdomain;
  }
  return outputs;
}

async function main() {
  const outputs = await resolveInstallationZone({
    zoneName: process.env.ZONE_NAME?.trim(),
    accountId: process.env.CF_ACCOUNT_ID?.trim(),
    token: process.env.CF_API_TOKEN?.trim(),
    withWorkersSubdomain: process.argv.includes('--workers-subdomain'),
  });
  const lines = Object.entries(outputs).map(([key, value]) => `${key}=${value}`);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join('\n')}\n`);
  }
  console.log(lines.join('\n'));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
