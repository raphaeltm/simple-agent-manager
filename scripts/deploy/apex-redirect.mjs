#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { validateBaseDomain } from './workflow-resource-names.mjs';

// Single Redirects support account-owned deployment tokens; Page Rules do not.
// https://developers.cloudflare.com/rules/url-forwarding/single-redirects/create-api/
export const REDIRECT_PHASE = 'http_request_dynamic_redirect';
export const APEX_REDIRECT_REF = 'sam_apex_to_www';

export function desiredApexRedirect(domain) {
  validateBaseDomain(domain);
  return {
    ref: APEX_REDIRECT_REF,
    description: 'Apex to canonical www marketing site - managed by provision-www',
    expression: `(http.host eq "${domain}")`,
    action: 'redirect',
    action_parameters: {
      from_value: {
        target_url: { expression: `concat("https://www.${domain}", http.request.uri.path)` },
        status_code: 301,
        preserve_query_string: true,
      },
    },
    enabled: true,
  };
}

function validId(value) {
  if (!/^[a-f0-9]{32}$/u.test(value ?? ''))
    throw new Error('Invalid Cloudflare resource identifier.');
  return value;
}

function sameRule(actual, desired) {
  return (
    actual?.ref === desired.ref &&
    actual.expression === desired.expression &&
    actual.action === desired.action &&
    actual.enabled === true &&
    isDeepStrictEqual(actual.action_parameters, desired.action_parameters)
  );
}

function buildPlan({ zonePath, entry, before, desired, remove }) {
  let method = 'POST';
  if (remove) method = before ? 'DELETE' : null;
  else if (sameRule(before, desired)) method = null;
  else if (before) method = 'PATCH';

  let path = `${zonePath}/rulesets`;
  if (entry) path += `/${validId(entry.id)}/rules`;
  if (before) path += `/${validId(before.id)}`;

  let after = desired;
  if (remove) after = null;
  else if (!entry)
    after = { name: 'Marketing redirects', kind: 'zone', phase: REDIRECT_PHASE, rules: [desired] };

  return { method, path, before, after };
}

export async function reconcileApexRedirect({
  domain,
  zoneId,
  request,
  apply = false,
  remove = false,
  report = () => {},
}) {
  const desired = desiredApexRedirect(domain);
  const zonePath = `/zones/${validId(zoneId)}`;
  const zone = await request(zonePath);
  if (zone.name !== domain) throw new Error('CF_ZONE_ID does not match BASE_DOMAIN.');
  if (!remove) {
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
  }
  // Read the exact phase entrypoint, avoiding pagination and unrelated phases.
  const entry = await request(`${zonePath}/rulesets/phases/${REDIRECT_PHASE}/entrypoint`, {
    allowMissing: true,
  });
  if (
    entry &&
    (entry.phase !== REDIRECT_PHASE || entry.kind !== 'zone' || !Array.isArray(entry.rules))
  ) {
    throw new Error('Refusing to modify a non-redirect ruleset.');
  }
  const owned = (entry?.rules ?? []).filter((rule) => rule.ref === APEX_REDIRECT_REF);
  if (owned.length > 1) throw new Error('Ambiguous managed apex rules; inspect before applying.');
  const before = owned[0] ?? null;
  if (before && (before.action !== 'redirect' || before.expression !== desired.expression))
    throw new Error('Refusing to replace a non-redirect rule or security settings.');
  // Never adopt/overwrite a separately managed exact apex rule.
  if (
    !remove &&
    (entry?.rules ?? []).some(
      (rule) => rule.ref !== APEX_REDIRECT_REF && rule.expression === desired.expression
    )
  ) {
    throw new Error('Unmanaged apex redirect exists; inspect before applying.');
  }
  const plan = buildPlan({ zonePath, entry, before, desired, remove });
  report(plan);
  if (apply && plan.method) {
    const result = await request(plan.path, {
      method: plan.method,
      ...(plan.after ? { body: plan.after } : {}),
    });
    const confirmed = result?.rules?.filter((rule) => rule.ref === APEX_REDIRECT_REF) ?? [];
    if (
      result?.phase !== REDIRECT_PHASE ||
      result?.kind !== 'zone' ||
      (remove
        ? confirmed.length !== 0
        : confirmed.length !== 1 || !sameRule(confirmed[0], desired)) ||
      !isDeepStrictEqual(
        result.rules.filter((rule) => rule.ref !== APEX_REDIRECT_REF),
        (entry?.rules ?? []).filter((rule) => rule.ref !== APEX_REDIRECT_REF)
      )
    ) {
      throw new Error(
        'Cloudflare did not confirm the requested apex redirect; inspect before retrying.'
      );
    }
  }
  return plan;
}

export function cloudflareRequest(token, fetcher = fetch) {
  if (!token) throw new Error('CF_API_TOKEN is required.');
  return async (path, { method = 'GET', body, allowMissing = false } = {}) => {
    const response = await fetcher(`https://api.cloudflare.com/client/v4${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const data = await response.json();
    if (
      allowMissing &&
      method === 'GET' &&
      path.endsWith(`/rulesets/phases/${REDIRECT_PHASE}/entrypoint`) &&
      response.status === 404 &&
      data.success === false &&
      data.errors?.some((error) => error.code === 10003)
    )
      return null;
    // Do not echo API bodies: a failing service must not leak credential material.
    if (!response.ok || data.success !== true || data.result == null) {
      const codes = Array.isArray(data.errors)
        ? data.errors.map((error) => error.code).filter((code) => Number.isSafeInteger(code))
        : [];
      throw new Error(
        `Cloudflare ${method} ${path} failed (HTTP ${response.status}; codes ${codes.join(',') || 'none'}).`
      );
    }
    return data.result;
  };
}

async function main() {
  const args = process.argv.slice(2);
  if (
    args.some((arg) => !['--apply', '--remove'].includes(arg)) ||
    new Set(args).size !== args.length
  )
    throw new Error('Usage: apex-redirect.mjs [--apply] [--remove]');
  const apply = args.includes('--apply');
  await reconcileApexRedirect({
    domain: process.env.BASE_DOMAIN,
    zoneId: process.env.CF_ZONE_ID,
    request: cloudflareRequest(process.env.CF_API_TOKEN),
    apply,
    remove: args.includes('--remove'),
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
  try {
    await main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
