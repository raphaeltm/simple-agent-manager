import { builderSource } from './builder';
import { cloudflare as cloudflareRequest, CloudflareError } from './cloudflare';
import type { InstallationCredentials } from './credentials';
import type { InstallationConfig } from './installation-plan';
import { maintenanceSource } from './maintenance';
import { digest } from './security';

export interface ProvisionInstallation {
  config: InstallationConfig;
  credentials: InstallationCredentials;
}
export async function provision(
  token: string,
  accountId: string,
  name: string,
  key: string,
  origin: string,
  expires: number,
  installation?: ProvisionInstallation,
  signal?: AbortSignal
): Promise<string | null> {
  const cloudflare = <T>(token: string, path: string, init: RequestInit = {}) =>
    cloudflareRequest<T>(token, path, { ...init, signal });
  const prefix = `/accounts/${accountId}/workers`;
  const subdomain = await cloudflare<{ subdomain: string }>(token, `${prefix}/subdomain`);
  if (!subdomain.subdomain || !/^[a-z0-9-]+$/.test(subdomain.subdomain)) return null;
  const identity = await digest(key);
  let exists = false;
  try {
    const settings = await cloudflare<{ bindings: { name: string; text?: string }[] }>(
      token,
      `${prefix}/scripts/${name}/settings`
    );
    const binding = (name: string) => settings.bindings?.find((b) => b.name === name)?.text;
    if (
      binding('INSTALLATION_ID') !== name ||
      binding('BOOTSTRAP_IDENTITY') !== identity ||
      binding('INSTALLER_ORIGIN') !== origin
    )
      throw new Error('Existing maintenance service does not match this bootstrap');
    exists = true;
  } catch (error) {
    if (!(error instanceof CloudflareError) || error.status !== 404) throw error;
  }
  const bucket = `${name}-builds`;
  const plain: Record<string, string> = {
    INSTALLER_ORIGIN: origin,
    CLAIM_EXPIRES: String(expires),
    INSTALLATION_ID: name,
    BOOTSTRAP_IDENTITY: identity,
    CLIENT_RECOVERY_REQUIRED: 'true',
  };
  const secrets: Record<string, string> = { OWNER_KEY_HASH: identity };
  if (installation) {
    const { config, credentials } = installation;
    if (config.accountId !== accountId) throw new Error('Installation account mismatch');
    Object.assign(plain, {
      CF_ACCOUNT_ID: accountId,
      SAM_ARTIFACTS_BUCKET: bucket,
      INSTALLATION_CONFIG: JSON.stringify(config),
    });
    Object.assign(secrets, {
      CF_API_TOKEN: credentials.deploymentToken,
      CF_RUNTIME_API_TOKEN: credentials.runtimeToken,
      R2_ACCESS_KEY_ID: credentials.r2AccessKeyId,
      R2_SECRET_ACCESS_KEY: credentials.r2SecretAccessKey,
      PULUMI_CONFIG_PASSPHRASE: credentials.pulumiPassphrase,
      BUILDER_CONTROL_SECRET: await digest(`builder:${key}`),
    });
    const buckets = await cloudflare<{ buckets: { name: string }[] }>(
      token,
      `/accounts/${accountId}/r2/buckets`
    );
    if (!buckets.buckets.some((b) => b.name === bucket))
      await cloudflare(token, `/accounts/${accountId}/r2/buckets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: bucket }),
      });
  }
  if (!exists) {
    const body = new FormData();
    body.set(
      'metadata',
      new Blob(
        [
          JSON.stringify({
            main_module: 'worker.js',
            compatibility_date: '2026-10-01',
            migrations: {
              new_tag: 'v1',
              new_sqlite_classes: ['MaintenanceCoordinator', 'InstallationBuilder'],
            },
            bindings: [
              {
                type: 'durable_object_namespace',
                name: 'MAINTENANCE',
                class_name: 'MaintenanceCoordinator',
              },
              {
                type: 'durable_object_namespace',
                name: 'BUILDER',
                class_name: 'InstallationBuilder',
              },
              ...Object.entries(plain).map(([name, text]) => ({ type: 'plain_text', name, text })),
              ...Object.entries(secrets).map(([name, text]) => ({
                type: 'secret_text',
                name,
                text,
              })),
              ...(installation
                ? [{ type: 'r2_bucket', name: 'BUILDER_ARTIFACTS', bucket_name: bucket }]
                : []),
            ],
          }),
        ],
        { type: 'application/json' }
      )
    );
    body.set(
      'worker.js',
      new Blob([maintenanceSource + '\n' + builderSource], {
        type: 'application/javascript+module',
      }),
      'worker.js'
    );
    await cloudflare(token, `${prefix}/scripts/${name}`, { method: 'PUT', body });
  }
  if (installation) {
    const applications = await cloudflare<{ id: string; name: string }[]>(
      token,
      `/accounts/${accountId}/containers/applications`
    );
    if (!applications.some((application) => application.name === `${name}-builder`))
      await cloudflare(token, `/accounts/${accountId}/containers/applications`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: `${name}-builder`,
          scheduling_policy: 'durable_object',
          durable_objects: { script_name: name, class_name: 'InstallationBuilder' },
        }),
      });
  }
  await cloudflare(token, `${prefix}/scripts/${name}/subdomain`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: true }),
  });
  return `https://${name}.${subdomain.subdomain}.workers.dev`;
}
