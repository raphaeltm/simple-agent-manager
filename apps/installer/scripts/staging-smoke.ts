import { cloudflare } from '../src/cloudflare';
import { provision } from '../src/provision';
import { randomSecret } from '../src/security';

// Pipeline-only test. Never revokes the deployment token, and never runs in production.
if (process.env.INSTALLER_ENVIRONMENT !== 'staging') throw new Error('Staging only');
const token = process.env.CLOUDFLARE_API_TOKEN;
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
if (!token || !accountId) throw new Error('Staging credentials missing');
const name = `sam-installer-smoke-${randomSecret().slice(0, 12)}`;
const key = randomSecret();
const origin = `https://install.${process.env.BASE_DOMAIN}`;
try {
  const url = await provision(token, accountId, name, key, origin, Date.now() + 120000);
  if (!url) throw new Error('Staging workers.dev subdomain unavailable');
  let ready = false;
  for (let attempt = 0; attempt < 12; attempt++) {
    try {
      if ((await fetch(`${url}/health`, { signal: AbortSignal.timeout(5000) })).ok) {
        ready = true;
        break;
      }
    } catch {
      /* DNS propagation */
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  if (!ready) throw new Error('Bootstrap health check timed out');
  if ((await fetch(url, { signal: AbortSignal.timeout(5000) })).status !== 401)
    throw new Error('Unauthenticated bootstrap access was not rejected');
  const claim = await fetch(`${url}/claim`, {
    signal: AbortSignal.timeout(10000),
    method: 'POST',
    headers: { Origin: origin },
    body: new URLSearchParams({ key }),
    redirect: 'manual',
  });
  if (claim.status !== 303 || !claim.headers.get('set-cookie'))
    throw new Error('Owner handoff failed');
  const landing = await fetch(url, {
    signal: AbortSignal.timeout(10000),
    headers: { Cookie: claim.headers.get('set-cookie')!.split(';')[0]! },
  });
  if (!landing.ok || !(await landing.text()).includes('Ownership handoff verified.'))
    throw new Error('Authenticated bootstrap landing failed');
  console.log(
    'Staging bootstrap upload, health, unauthenticated rejection and owner handoff verified. OAuth consent is a separate browser check.'
  );
} finally {
  await cloudflare(token, `/accounts/${accountId}/workers/scripts/${name}`, { method: 'DELETE' });
  console.log('Temporary staging bootstrap Worker deleted.');
}
