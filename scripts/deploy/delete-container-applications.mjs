#!/usr/bin/env node
/**
 * Delete the Cloudflare Containers applications of one installation's API Worker.
 *
 * Wrangler names them `<api worker>-<durable object class>-<stack>` (for example
 * `sam2-api-staging2-sandboxdo-staging2`). They outlive the Worker: after a teardown they stay
 * bound to the deleted Durable Object namespace, and the next deploy of the same installation
 * fails with "There is already an application with the name ... associated with a different
 * durable object namespace". Only applications whose name has exactly this Worker's prefix and
 * this stack's suffix are deleted, so another installation's applications are never touched.
 */
import { appendFileSync } from 'node:fs';

const API = 'https://api.cloudflare.com/client/v4';

async function cloudflare(fetchImpl, token, method, path) {
  const response = await fetchImpl(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}` },
  });
  if (method === 'DELETE' && response.status === 404) return { success: true };
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.success) {
    const message = body?.errors?.map((e) => e.message).join('; ') || `HTTP ${response.status}`;
    throw new Error(`${method} ${path} failed: ${message}`);
  }
  return body;
}

/** The applications Wrangler created for this Worker and stack, by exact name shape. */
export function installationApplications(applications, apiWorker, stack) {
  const prefix = `${apiWorker}-`;
  const suffix = `-${stack}`;
  return applications.filter((app) => {
    const name = typeof app?.name === 'string' ? app.name : '';
    if (!name.startsWith(prefix) || !name.endsWith(suffix)) return false;
    const className = name.slice(prefix.length, name.length - suffix.length);
    return /^[a-z0-9]+$/u.test(className);
  });
}

export async function deleteContainerApplications({
  accountId,
  token,
  apiWorker,
  stack,
  dryRun = false,
  fetchImpl = fetch,
  log = (message) => console.log(message),
}) {
  if (!accountId || !token || !apiWorker || !stack) {
    throw new Error('CF_ACCOUNT_ID, CF_API_TOKEN, API_WORKER and STACK are required.');
  }
  if (!/^[a-z0-9-]+$/u.test(apiWorker) || !/^[a-z0-9_-]+$/u.test(stack)) {
    throw new Error('API_WORKER and STACK must be plain resource names.');
  }
  const base = `/accounts/${encodeURIComponent(accountId)}/containers/applications`;
  const listed = await cloudflare(fetchImpl, token, 'GET', base);
  const targets = installationApplications(listed.result ?? [], apiWorker, stack);
  for (const app of targets) {
    if (dryRun) {
      log(`DRY RUN: Would delete container application ${app.name}`);
      continue;
    }
    await cloudflare(fetchImpl, token, 'DELETE', `${base}/${encodeURIComponent(app.id)}`);
    log(`Deleted container application ${app.name}`);
  }
  return targets.map((app) => app.name);
}

async function main() {
  const names = await deleteContainerApplications({
    accountId: process.env.CF_ACCOUNT_ID?.trim(),
    token: process.env.CF_API_TOKEN?.trim(),
    apiWorker: process.env.API_WORKER?.trim(),
    stack: process.env.STACK?.trim(),
    dryRun: process.env.INPUT_DRY_RUN === 'true',
  });
  const status =
    names.length === 0 ? 'not_found' : process.env.INPUT_DRY_RUN === 'true' ? 'dry_run' : 'deleted';
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `status=${status}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
