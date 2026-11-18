import { type AdminSettingDefinition, integerDefinition } from './admin-setting-definitions';

export const DEFAULT_ACCOUNT_LINK_PROOF_TTL_SECONDS = 300;

export const ACCOUNT_LINKING_SETTINGS: AdminSettingDefinition[] = [
  integerDefinition(
    'security.accountLinkProofTtlSeconds',
    DEFAULT_ACCOUNT_LINK_PROOF_TTL_SECONDS,
    'Email',
    'Seconds to complete a one-time emailed account-link sign-in check, including provider consent. Applies to new confirmation emails; existing proofs retain their original deadline.',
    { min: 60, max: 900 }
  ),
];
