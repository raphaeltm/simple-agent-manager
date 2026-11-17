import { type AdminSettingDefinition, integerDefinition } from './admin-setting-definitions';

export const DEFAULT_SETUP_SESSION_CLEANUP_RECOVERY_STEP_TIMEOUT_MS = 5_000;

export const CREDENTIAL_SETUP_SETTINGS: readonly AdminSettingDefinition[] = [
  integerDefinition(
    'credentialSetup.cleanupRecoveryStepTimeoutMs',
    DEFAULT_SETUP_SESSION_CLEANUP_RECOVERY_STEP_TIMEOUT_MS,
    'Operations',
    'Per-step deadline in milliseconds for guided-login cleanup recovery: D1 repair, sandbox scrub, destruction and pool release each get this budget, capped by the interactive sandbox exec timeout. Three recovery attempts are allowed before quarantine.',
    { min: 1, max: 10_000 }
  ),
];
