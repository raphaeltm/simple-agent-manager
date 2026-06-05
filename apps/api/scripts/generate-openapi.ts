import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { samCliOpenApiDocument } from '../src/openapi/sam-cli';

const currentDir = dirname(fileURLToPath(import.meta.url));
const apiRoot = resolve(currentDir, '..');
const outputPath = resolve(apiRoot, 'openapi/sam-cli.openapi.json');

function serializeContract(): string {
  return `${JSON.stringify(samCliOpenApiDocument, null, 2)}\n`;
}

async function main(): Promise<void> {
  const checkOnly = process.argv.includes('--check');
  const contract = serializeContract();

  if (checkOnly) {
    const existing = await readFile(outputPath, 'utf8');
    if (existing !== contract) {
      throw new Error(
        `OpenAPI contract is stale. Run pnpm --filter @simple-agent-manager/api openapi:generate and commit ${outputPath}.`,
      );
    }
    return;
  }

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, contract, 'utf8');
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
