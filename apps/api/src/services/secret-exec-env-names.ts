import { WORKLOAD_IDENTITY_TOKEN_ENV } from '@simple-agent-manager/shared';

/**
 * Names `exec_with_secrets` refuses to set: shell startup controls, read-only shell variables and
 * the workload identity token it injects itself. A secret request for one of these names could
 * never be used, so `request_secret` refuses them too.
 */
export const UNSUPPORTED_SECRET_EXEC_ENV_NAMES: ReadonlySet<string> = new Set([
  WORKLOAD_IDENTITY_TOKEN_ENV,
  'ENV',
  'BASH_ENV',
  'UID',
  'EUID',
  'PPID',
  'SHELLOPTS',
  'BASHOPTS',
  'BASH_VERSINFO',
]);
