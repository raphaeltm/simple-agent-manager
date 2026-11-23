import { cloudflare } from '../src/cloudflare';
import { provision } from '../src/provision';
import { digest, randomSecret } from '../src/security';

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
  const readinessDeadline = Date.now() + 60000;
  let ready = false;
  let lastStatus = 'No response';
  for (let attempt = 0; attempt < 12 && Date.now() < readinessDeadline; attempt++) {
    let health: Response;
    let anonymous: Response;
    try {
      health = await fetch(`${url}/health`, {
        signal: AbortSignal.timeout(5000),
        redirect: 'manual',
      });
      anonymous = await fetch(url, { signal: AbortSignal.timeout(5000), redirect: 'manual' });
    } catch {
      lastStatus = 'Network request failed during propagation';
      await new Promise((resolve) => setTimeout(resolve, 2000));
      continue;
    }
    lastStatus = `health=${health.status}, anonymous=${anonymous.status}; cf-ray=${anonymous.headers.get('cf-ray')}`;
    // Only retry deployment-not-ready responses; never hide an auth regression.
    if (![401, 404, 503].includes(anonymous.status))
      throw new Error(`Unauthenticated bootstrap expected401; ${lastStatus}`);
    if (health.ok && anonymous.status === 401) {
      const data = (await health.json()) as { kind?: string };
      if (data.kind !== 'sam-maintenance') throw new Error('Unexpected bootstrap health payload');
      ready = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  if (!ready) throw new Error(`Bootstrap propagation timed out; ${lastStatus}`);
  // The readiness loop above saw one edge location answer. The requests below can reach
  // another that does not serve the new Worker yet (404, 503), so those two statuses are
  // retried inside the same window. Anything else, such as a refused claim, fails at once
  // and reports its status: an auth regression is never retried away.
  const settled = async (label: string, request: () => Promise<Response>) => {
    for (;;) {
      const response = await request();
      if (![404, 503].includes(response.status) || Date.now() >= readinessDeadline)
        return response;
      lastStatus = `${label}=${response.status}; cf-ray=${response.headers.get('cf-ray')}`;
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  };
  const recovery = await digest(randomSecret());
  const claim = await settled('claim', () =>
    fetch(`${url}/claim`, {
      signal: AbortSignal.timeout(10000),
      method: 'POST',
      headers: { Origin: origin },
      body: new URLSearchParams({ key, recovery }),
      redirect: 'manual',
    })
  );
  if (claim.status !== 200 || !claim.headers.get('set-cookie'))
    throw new Error(
      `Owner handoff failed; claim=${claim.status}, cookie=${claim.headers.has('set-cookie')}; cf-ray=${claim.headers.get('cf-ray')}`
    );
  const cookie = claim.headers.get('set-cookie')!.split(';')[0]!;
  const landing = await settled('landing', () =>
    fetch(url, { signal: AbortSignal.timeout(10000), headers: { Cookie: cookie } })
  );
  if (!landing.ok || !(await landing.text()).includes('Ownership handoff verified.'))
    throw new Error(
      `Authenticated bootstrap landing failed; landing=${landing.status}; cf-ray=${landing.headers.get('cf-ray')}`
    );
  console.log(
    'Staging bootstrap upload, health, unauthenticated rejection and owner handoff verified. OAuth consent is a separate browser check.'
  );
} finally {
  await cloudflare(token, `/accounts/${accountId}/workers/scripts/${name}?force=true`, {
    method: 'DELETE',
  });
  console.log('Temporary staging bootstrap Worker deleted.');
}
