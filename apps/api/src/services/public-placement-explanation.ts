import {
  assertPlacementDiagnosticsAreUserSafe,
  PLACEMENT_DIAGNOSTICS_VERSION,
} from '@simple-agent-manager/shared';

/** API projections expose decision evidence, never the internal allocation audit envelope. */
export function publicPlacementExplanationJson(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const envelope: unknown = JSON.parse(raw);
    if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) return null;
    const diagnostics = (envelope as Record<string, unknown>).diagnostics;
    if (!diagnostics || typeof diagnostics !== 'object' || Array.isArray(diagnostics)) return null;
    if ((diagnostics as Record<string, unknown>).version !== PLACEMENT_DIAGNOSTICS_VERSION)
      return null;
    assertPlacementDiagnosticsAreUserSafe(diagnostics);
    return JSON.stringify({ diagnostics });
  } catch {
    return null;
  }
}
