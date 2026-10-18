#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { validateBaseDomain } from './workflow-resource-names.mjs';

// Existing provision-www Page Rule contract. The scheme is omitted deliberately:
// Cloudflare matches HTTP and HTTPS; $1 retains the entire path/query suffix.
// https://developers.cloudflare.com/rules/page-rules/reference/wildcard-matching/
export function desiredApexRedirect(domain) {
  validateBaseDomain(domain);
  return {
    targets: [{ target: 'url', constraint: { operator: 'matches', value: `${domain}/*` } }],
    actions: [
      { id: 'forwarding_url', value: { url: `https://www.${domain}/$1`, status_code: 301 } },
    ],
    status: 'active',
  };
}

export async function reconcileApexRedirect({
  domain,
  zoneId,
  request,
  apply = false,
  report = () => {},
}) {
  const desired = desiredApexRedirect(domain);
  if (!/^[a-f0-9]{32}$/u.test(zoneId ?? ''))
    throw new Error('CF_ZONE_ID must be a zone identifier.');
  const zonePath = `/zones/${zoneId}`;
  const zone = await request(zonePath);
  if (zone.name !== domain) throw new Error('CF_ZONE_ID does not match BASE_DOMAIN.');
  const dns = await request(`${zonePath}/dns_records?name=${encodeURIComponent(domain)}`);
  if (
    !Array.isArray(dns) ||
    !dns.some(
      (record) =>
        record.name === domain &&
        record.proxied === true &&
        ['A', 'AAAA', 'CNAME'].includes(record.type)
    )
  ) {
    throw new Error('Apex must already have proxied DNS; no DNS changes will be made.');
  }
  // Query both states explicitly: the API's default filter is not a contract
  // to rely on, and an inactive rule must be repaired rather than duplicated.
  const active = await request(`${zonePath}/pagerules?status=active`);
  const disabled = await request(`${zonePath}/pagerules?status=disabled`);
  if (!Array.isArray(active) || !Array.isArray(disabled))
    throw new Error('Invalid Page Rule list response.');
  const matches = [...active, ...disabled].filter((rule) =>
    rule.targets?.some((target) => target.constraint?.value === `${domain}/*`)
  );
  if (matches.length > 1)
    throw new Error('Ambiguous apex rules; inspect the existing rules before applying.');
  const before = matches[0] ?? null;
  if (
    before &&
    (before.targets.length !== 1 ||
      before.targets[0].target !== 'url' ||
      before.targets[0].constraint.operator !== 'matches' ||
      before.actions?.length !== 1 ||
      before.actions[0].id !== 'forwarding_url')
  ) {
    throw new Error('Refusing to replace a non-redirect apex rule or security settings.');
  }
  if (before && !/^[a-zA-Z0-9_-]+$/u.test(before.id ?? ''))
    throw new Error('Invalid Page Rule identifier.');
  const after = {
    ...desired,
    ...(before?.priority !== undefined ? { priority: before.priority } : {}),
  };
  const unchanged =
    before?.status === desired.status &&
    before.actions[0].value?.url === desired.actions[0].value.url &&
    before.actions[0].value?.status_code === 301;
  const plan = {
    method: unchanged ? null : before ? 'PUT' : 'POST',
    path: `${zonePath}/pagerules${before ? `/${before.id}` : ''}`,
    before,
    after,
  };
  report(plan);
  if (apply && plan.method) {
    const result = await request(plan.path, { method: plan.method, body: after });
    if (
      !result?.id ||
      result.status !== after.status ||
      result.targets?.[0]?.constraint?.value !== `${domain}/*` ||
      result.actions?.[0]?.value?.url !== after.actions[0].value.url ||
      result.actions?.[0]?.value?.status_code !== 301
    ) {
      throw new Error(
        'Cloudflare did not confirm the requested apex redirect; inspect the rule before retrying.'
      );
    }
  }
  return plan;
}

export function cloudflareRequest(token, fetcher = fetch) {
  if (!token) throw new Error('CF_API_TOKEN is required.');
  return async (path, { method = 'GET', body } = {}) => {
    const response = await fetcher(`https://api.cloudflare.com/client/v4${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const data = await response.json();
    // Do not echo API bodies: a failing service must not leak credential material.
    if (!response.ok || data.success !== true || data.result == null) {
      throw new Error(`Cloudflare ${method} ${path} failed (HTTP ${response.status}).`);
    }
    return data.result;
  };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== '--apply') || args.length > 1)
    throw new Error('Usage: apex-redirect.mjs [--apply]');
  const apply = args.includes('--apply');
  await reconcileApexRedirect({
    domain: process.env.BASE_DOMAIN,
    zoneId: process.env.CF_ZONE_ID,
    request: cloudflareRequest(process.env.CF_API_TOKEN),
    apply,
    report: (plan) => {
      const output = JSON.stringify({ apply, ...plan }, null, 2);
      console.log(output);
      if (process.env.GITHUB_STEP_SUMMARY)
        appendFileSync(
          process.env.GITHUB_STEP_SUMMARY,
          `## Apex redirect ${apply ? 'application' : 'plan'}\n\n\`\`\`json\n${output}\n\`\`\`\n`
        );
    },
  });
  console.log(
    apply
      ? 'Apex redirect reconciled; verify public routing.'
      : 'Read-only plan complete; no changes applied.'
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
