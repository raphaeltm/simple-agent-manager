import { readFileSync } from 'node:fs';
import { join } from 'node:path';

interface Spec {
  agentType: string;
  method: 'npm' | 'uv-tool';
  package: string;
  version: string;
  bin: string;
  python?: string;
  extraPackages?: string[];
  npmCompanion?: { package: string; version: string };
  postInstallHook?: 'amp-sdk-patch';
}
const root = process.cwd();
const specs = JSON.parse(
  readFileSync(join(root, 'packages/shared/src/agent-install-manifest.json'), 'utf8')
) as Spec[];
const goSource = readFileSync(join(root, 'packages/vm-agent/internal/acp/gateway.go'), 'utf8');
const dockerfile = readFileSync(join(root, 'apps/api/Dockerfile.vm-agent-container'), 'utf8');
const catalog = readFileSync(join(root, 'packages/shared/src/agents.ts'), 'utf8');
const safePackage = /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/;
const safeVersion = /^[0-9][0-9A-Za-z.+-]*$/;
const ids = new Set<string>();
for (const spec of specs) {
  if (
    ids.has(spec.agentType) ||
    !safePackage.test(spec.package) ||
    !safeVersion.test(spec.version) ||
    !/^[a-z0-9._-]+$/.test(spec.bin)
  )
    throw new Error(`Invalid install manifest entry: ${spec.agentType}`);
  ids.add(spec.agentType);
  const pin = `${spec.package}${spec.method === 'npm' ? '@' : '=='}${spec.version}`;
  if (!goSource.includes(pin)) throw new Error(`Go installer is missing ${pin}`);
  if (!dockerfile.includes(pin)) throw new Error(`cf-container image is missing ${pin}`);
  if (!catalog.includes(`id: '${spec.agentType}'`))
    throw new Error(`Agent catalog is missing ${spec.agentType}`);
  if (spec.npmCompanion) {
    const companion = `${spec.npmCompanion.package}@${spec.npmCompanion.version}`;
    if (!goSource.includes(companion) || !dockerfile.includes(companion))
      throw new Error(`Runtime outputs are missing ${companion}`);
  }
}
const catalogIds = [...catalog.matchAll(/\bid: '([^']+)'/g)].map((m) => m[1]);
if (catalogIds.some((id) => !ids.has(id)))
  throw new Error('Agent catalog and install manifest IDs differ');
console.log(`Agent install manifest is valid and synchronized (${specs.length} agents).`);
