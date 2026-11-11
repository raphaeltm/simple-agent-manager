/**
 * Admin settings for outbound requests to URLs SAM did not choose itself (lib/network-hosts):
 * how many validated redirect hops a guarded fetch follows, and whether the admin-configured
 * GitLab host may be on the private network. Runtime tunables are admin settings, not Worker
 * vars (policy 9017df94).
 */
import { DEFAULT_OUTBOUND_MAX_REDIRECTS, MAX_OUTBOUND_REDIRECTS } from '../lib/network-hosts';
import {
  type AdminSettingDefinition,
  integerDefinition,
  switchDefinition,
} from './admin-setting-definitions';

export type OutboundSettingName = 'outbound.maxRedirects' | 'integration.gitlab.allowPrivateNetwork';

export const OUTBOUND_SETTINGS: readonly AdminSettingDefinition[] = [
  integerDefinition(
    'outbound.maxRedirects',
    DEFAULT_OUTBOUND_MAX_REDIRECTS,
    'Operations',
    'Redirect hops SAM follows for a URL a user or admin chose (AI proxy base URLs, the OpenAI-compatible endpoint, GitLab, check_dns_status). Every hop is re-checked; 0 refuses every redirect.',
    { min: 0, max: MAX_OUTBOUND_REDIRECTS }
  ),
  switchDefinition(
    'integration.gitlab.allowPrivateNetwork',
    false,
    'OAuth',
    'Let SAM call a GitLab host on this machine or its private network (loopback, 10/8, 172.16/12, 192.168/16), for sign-in and the GitLab API. Off: such a host is refused. Cloud metadata addresses are refused either way.',
    {}
  ),
];
