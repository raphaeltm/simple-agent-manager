interface DeploymentMetadata {
  deployments?: Array<{ versions?: Array<{ version_id: string; percentage: number }> }>;
  annotations?: Record<string, string>;
  canonical_deployment?: {
    deployment_trigger?: { metadata?: { commit_hash?: string } };
    latest_stage?: { name?: string; status?: string };
  };
}
/** Account metadata proves source identity; public checks prove the routed UI/API are usable. */
interface ReadinessOptions {
  request(url: string, init?: RequestInit): Promise<Response>;
  apiBase: string;
  accountId: string;
  token: string;
  worker: string;
  pages: string;
  domain: string;
  commit: string;
}
export async function verifyEngineReadiness(options: ReadinessOptions): Promise<void> {
  const { request } = options;
  const account = async (path: string) => {
    const response = await request(`${options.apiBase}/accounts/${options.accountId}/${path}`, {
      headers: { Authorization: `Bearer ${options.token}` },
    });
    if (!response.ok) throw new Error('Deployment metadata unavailable');
    const body = (await response.json()) as { success?: boolean; result: DeploymentMetadata };
    if (body.success !== true) throw new Error('Deployment metadata unavailable');
    return body.result;
  };
  const deployments = await account(`workers/scripts/${options.worker}/deployments`);
  const versions = deployments.deployments?.[0]?.versions;
  if (!Array.isArray(versions) || versions.length !== 1 || versions[0].percentage !== 100)
    throw new Error('Expected one active Worker version');
  const version = await account(
    `workers/scripts/${options.worker}/versions/${versions[0].version_id}`
  );
  if (version.annotations?.['workers/tag'] !== options.commit)
    throw new Error('Worker source identity mismatch');
  const project = await account(`pages/projects/${options.pages}`);
  const production = project.canonical_deployment;
  if (
    production?.deployment_trigger?.metadata?.commit_hash !== options.commit ||
    production?.latest_stage?.name !== 'deploy' ||
    production?.latest_stage?.status !== 'success'
  )
    throw new Error('Pages source identity mismatch');
  const health = await request(`https://api.${options.domain}/health`);
  if (!health.ok || ((await health.json()) as { status?: string }).status !== 'healthy')
    throw new Error('API unavailable');
  await verifySetup(options);
  await verifyApplication(options);
}

async function verifySetup(options: ReadinessOptions): Promise<void> {
  const { request } = options;
  const setup = await request(`https://api.${options.domain}/api/setup/status`);
  if (setup.status === 410) {
    if (((await setup.json()) as { error?: string }).error !== 'SETUP_CLOSED')
      throw new Error('Setup unavailable');
  } else {
    const status = (await setup.json()) as { open?: boolean; tokenConfigured?: boolean };
    if (!setup.ok || status.open !== true || status.tokenConfigured !== true)
      throw new Error('Setup unavailable');
  }
}

async function verifyApplication(options: ReadinessOptions): Promise<void> {
  const { request } = options;
  for (const path of ['/', '/setup']) {
    const response = await request(`https://app.${options.domain}${path}`);
    const html = await response.text();
    if (
      !response.ok ||
      !response.headers.get('content-type')?.includes('text/html') ||
      !/<div[^>]+id=["']root["']/.test(html)
    )
      throw new Error('Application unavailable');
    const script = /<script[^>]+src=["']([^"']+)["']/.exec(html)?.[1];
    if (!script) throw new Error('Application entrypoint missing');
    const url = new URL(script, `https://app.${options.domain}`);
    if (url.origin !== `https://app.${options.domain}`)
      throw new Error('Unexpected application asset');
    const asset = await request(url.href);
    if (
      !asset.ok ||
      !/javascript/.test(asset.headers.get('content-type') ?? '') ||
      !(await asset.text()).trim()
    )
      throw new Error('Application asset unavailable');
  }
}
