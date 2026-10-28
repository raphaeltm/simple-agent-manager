import { cloudflare } from './cloudflare';
import { maintenanceSource } from './maintenance';
import { digest } from './security';
export async function provision(
  token: string,
  accountId: string,
  name: string,
  key: string,
  origin: string,
  expires: number
): Promise<string | null> {
  const prefix = `/accounts/${accountId}/workers`;
  const subdomain = await cloudflare<{ subdomain: string }>(token, `${prefix}/subdomain`);
  if (!subdomain.subdomain || !/^[a-z0-9-]+$/.test(subdomain.subdomain)) return null;
  const body = new FormData();
  body.set(
    'metadata',
    new Blob(
      [
        JSON.stringify({
          main_module: 'worker.js',
          compatibility_date: '2026-10-01',
          bindings: [
            { type: 'secret_text', name: 'OWNER_KEY_HASH', text: await digest(key) },
            { type: 'plain_text', name: 'INSTALLER_ORIGIN', text: origin },
            { type: 'plain_text', name: 'CLAIM_EXPIRES', text: String(expires) },
          ],
        }),
      ],
      { type: 'application/json' }
    )
  );
  body.set(
    'worker.js',
    new Blob([maintenanceSource], { type: 'application/javascript+module' }),
    'worker.js'
  );
  await cloudflare(token, `${prefix}/scripts/${name}`, { method: 'PUT', body });
  await cloudflare(token, `${prefix}/scripts/${name}/subdomain`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: true }),
  });
  return `https://${name}.${subdomain.subdomain}.workers.dev`;
}
