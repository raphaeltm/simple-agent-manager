export function normalizeAgentVersion(version: string | null | undefined): string | null {
  const trimmed = version?.trim();
  return trimmed ? trimmed : null;
}

export function isNodeAgentVersionCompatible(
  nodeAgentVersion: string | null | undefined,
  requiredAgentVersion: string | null | undefined
): boolean {
  const required = normalizeAgentVersion(requiredAgentVersion);
  if (!required) {
    return true;
  }
  return normalizeAgentVersion(nodeAgentVersion) === required;
}
