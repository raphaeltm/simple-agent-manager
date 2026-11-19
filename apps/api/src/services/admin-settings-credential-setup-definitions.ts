import { type AdminSettingDefinition, integerDefinition } from './admin-setting-definitions';

export const DEFAULT_SETUP_SESSION_CLEANUP_RECOVERY_STEP_TIMEOUT_MS = 5_000;
export const DEFAULT_SETUP_SESSION_MAX_CLEANUP_RECOVERY_ATTEMPTS = 3;

export const CREDENTIAL_SETUP_SETTINGS: readonly AdminSettingDefinition[] = [
  integerDefinition(
    'credentialSetup.cleanupRecoveryStepTimeoutMs',
    DEFAULT_SETUP_SESSION_CLEANUP_RECOVERY_STEP_TIMEOUT_MS,
    'Operations',
    'Per-step deadline in milliseconds for guided-login cleanup recovery: D1 repair, sandbox scrub, destruction and pool release each get this budget, capped by the interactive sandbox exec timeout. The retry cap is configured separately.',
    { min: 1, max: 10_000 }
  ),
  integerDefinition(
    'credentialSetup.cleanupRecoveryMaxAttempts',
    DEFAULT_SETUP_SESSION_MAX_CLEANUP_RECOVERY_ATTEMPTS,
    'Operations',
    'Maximum failed guided-login cleanup recovery attempts before quarantine, snapshotted when recovery first starts. A nonzero cap preserves cleanup; the finite maximum bounds recovery work.',
    { min: 1, max: 10 }
  ),
];
