import type { CredentialProvider } from '@simple-agent-manager/shared';

/**
 * Resolves the Hetzner base image override from the `HETZNER_BASE_IMAGE` env var.
 *
 * The default (returned as `undefined`) lets the Hetzner provider pick its own
 * default — currently `docker-ce` (Hetzner's Docker marketplace image, which
 * skips Docker install and saves ~30-60s on cold provisioning). Setting
 * `HETZNER_BASE_IMAGE=ubuntu-24.04` provides an emergency rollback without a
 * code change. The override is only applied for the Hetzner provider; other
 * providers have their own image resolution logic.
 *
 * Exported for unit-testing the env-var → provider plumbing.
 */
export function resolveHetznerBaseImageOverride(
  targetProvider: CredentialProvider | undefined,
  envValue: string | undefined
): string | undefined {
  if (targetProvider !== 'hetzner') return undefined;
  const trimmed = envValue?.trim();
  return trimmed ? trimmed : undefined;
}
