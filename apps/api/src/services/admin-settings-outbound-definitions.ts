/**
 * Admin settings for outbound requests to URLs SAM did not choose itself (`guardedFetch` in
 * `@simple-agent-manager/worker-core`): how many validated redirect hops a guarded fetch follows.
 * Runtime tunables are admin settings, not Worker vars (.claude/rules/07-env-and-urls.md).
 */
import {
  DEFAULT_OUTBOUND_MAX_REDIRECTS,
  MAX_OUTBOUND_REDIRECTS,
} from '@simple-agent-manager/worker-core';

import { type AdminSettingDefinition, integerDefinition } from './admin-setting-definitions';

export type OutboundSettingName = 'outbound.maxRedirects';

export const OUTBOUND_SETTINGS: readonly AdminSettingDefinition[] = [
  integerDefinition(
    'outbound.maxRedirects',
    DEFAULT_OUTBOUND_MAX_REDIRECTS,
    'Operations',
    'Redirect hops a guarded outbound request follows when the server it calls answers with a redirect (including GitLab profile/API calls and check_dns_status; DNS checks also stay on the workspace origin). Every hop is re-checked; 0 refuses every redirect.',
    { min: 0, max: MAX_OUTBOUND_REDIRECTS }
  ),
];
