/** Persist exact public resource identities before stopping a disposable installation. */
import { readRecord } from '../../deploy/selfhost/created-resources.mjs';
import type { TeardownContext } from './teardown-box';
import type { ComposeInventory } from './teardown-compose';
import { expectedTeardownProject } from './teardown-identity';
import { updateRemovalProof } from './teardown-record';

function scope(ctx: TeardownContext) {
  return {
    installation: ctx.installationId,
    domain: ctx.domain,
    state: ctx.stateDir,
    environment: ctx.envFile,
    files: ctx.composeFiles,
  };
}
function identities(inventory: ComposeInventory) {
  return {
    containers: inventory.containers.map((c) => c.id),
    volumes: inventory.volumes.map((v) => ({ name: v.name, createdAt: v.createdAt })),
  };
}
function progress(
  ctx: TeardownContext
): { containers: string[]; volumes: { name: string; createdAt: string }[] } | null {
  const project = expectedTeardownProject(ctx);
  const record = readRecord(ctx.recordFile).resources.find(
    (r) => r.cloud === 'box' && r.kind === 'compose-project' && r.name === project
  );
  const text = record?.attributes?.teardownInventory;
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      JSON.stringify(parsed.scope) !== JSON.stringify(scope(ctx)) ||
      !Array.isArray(parsed.containers) ||
      parsed.containers.some(
        (id: unknown) => typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)
      ) ||
      new Set(parsed.containers).size !== parsed.containers.length ||
      !Array.isArray(parsed.volumes) ||
      parsed.volumes.some(
        (v: { name?: unknown; createdAt?: unknown }) =>
          !v ||
          typeof v.name !== 'string' ||
          !v.name.startsWith(`${project}_`) ||
          typeof v.createdAt !== 'string' ||
          !v.createdAt
      ) ||
      new Set(parsed.volumes.map((v: { name: string }) => v.name)).size !== parsed.volumes.length
    )
      throw new Error('Invalid pending inventory');
    return parsed;
  } catch {
    throw new Error('Refused: unreadable or foreign pending Docker removal proof');
  }
}
export function assertPendingComposeInventory(
  ctx: TeardownContext,
  inventory: ComposeInventory
): void {
  const pending = progress(ctx);
  if (!pending) return;
  const current = identities(inventory);
  if (
    current.containers.some((id) => !pending.containers.includes(id)) ||
    current.volumes.some(
      (v) => !pending.volumes.some((old) => old.name === v.name && old.createdAt === v.createdAt)
    )
  )
    throw new Error('Refused: replacement Docker resource appeared during interrupted teardown');
}
export function authorizeComposeRemoval(ctx: TeardownContext, inventory: ComposeInventory): void {
  assertPendingComposeInventory(ctx, inventory);
  if (progress(ctx)) return;
  updateRemovalProof(ctx.recordFile, 'compose-project', expectedTeardownProject(ctx), {
    teardownInventory: JSON.stringify({ scope: scope(ctx), ...identities(inventory) }),
  });
}
export function finishKeepDataRemoval(ctx: TeardownContext): void {
  updateRemovalProof(ctx.recordFile, 'compose-project', expectedTeardownProject(ctx), {
    teardownInventory: '',
  });
}
