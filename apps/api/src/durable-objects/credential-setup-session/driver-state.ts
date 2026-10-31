import * as v from 'valibot';

const timestamp = v.optional(
  v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(Number.MAX_SAFE_INTEGER))
);
/** Strict projection: no CLI text, URLs, codes, tokens, or arbitrary metadata. */
export const DriverDiagnosticsSchema = v.object({
  startedAt: timestamp,
  urlReadyAt: timestamp,
  codeReadAt: timestamp,
  codeWrittenAt: timestamp,
  enterWrittenAt: timestamp,
  oauthErrorAt: timestamp,
  tokenCapturedAt: timestamp,
  exitAt: timestamp,
  closeAt: timestamp,
  stateMatched: v.optional(v.boolean()),
  cliVersion: v.optional(v.pipe(v.string(), v.regex(/^\d{1,3}\.\d{1,3}\.\d{1,3}$/))),
  exitCode: v.optional(v.pipe(v.number(), v.integer(), v.minValue(-1), v.maxValue(255))),
  signal: v.optional(
    v.picklist([
      'SIGTERM',
      'SIGKILL',
      'SIGINT',
      'SIGHUP',
      'SIGPIPE',
      'SIGABRT',
      'SIGSEGV',
      'SIGBUS',
      'SIGQUIT',
    ])
  ),
});
export const DeviceAuthStateSchema = v.object({
  status: v.picklist(['starting', 'waiting_for_user', 'completed', 'failed']),
  verificationUrl: v.optional(v.string()),
  userCode: v.optional(v.nullable(v.string())),
  error: v.optional(v.nullable(v.string())),
  code: v.optional(v.string()),
  detail: v.optional(v.nullable(v.string())),
  // Bad diagnostics must not hide an otherwise actionable terminal result.
  diagnostics: v.optional(v.fallback(DriverDiagnosticsSchema, {})),
});
export type DeviceAuthState = v.InferOutput<typeof DeviceAuthStateSchema>;

const failures: Record<string, string> = {
  code_rejected: 'Claude rejected the verification code. Start again and use a fresh code.',
  code_incomplete:
    'The pasted code was incomplete. Copy the entire code Claude shows — it has a # in the middle — then start again.',
  code_state_mismatch:
    'That code belongs to a different sign-in attempt. Start again and use the code from the newly opened Claude page.',
  exchange_timeout: 'Claude sign-in did not complete in time. Start again and paste a fresh code.',
  exchange_network_error:
    'The sign-in sandbox hit a network error talking to Claude. Start again in a moment.',
  exchange_provider_error: 'Claude could not complete the sign-in request. Try again in a moment.',
  exchange_failed: 'Claude could not complete sign-in. Please start again.',
  process_start_failed: 'The Claude sign-in process could not start. Please try again.',
  process_exited: 'The Claude sign-in process stopped before returning a token. Please try again.',
  stdin_write_failed: 'SAM could not send the verification code to Claude. Please start again.',
  code_read_failed: 'SAM could not read the submitted verification code. Please start again.',
  output_parse_failed: 'SAM could not read the Claude sign-in result. Please start again.',
  credential_write_failed: 'SAM could not capture the Claude token. Please start again.',
};

export function driverFailure(
  state: DeviceAuthState,
  displayName: string
): { code: string; message: string } {
  const code = state.code && Object.hasOwn(failures, state.code) ? state.code : 'setup_failed';
  let message = failures[code] ?? `${displayName} could not complete sign-in. Please start again.`;
  // Compatibility with older driver images, without echoing arbitrary text.
  const status = /^(?:HTTP ([1-5]\d{2})|.*status\s*code\s*([1-5]\d{2}).*)$/i.exec(
    state.detail ?? ''
  );
  const network = [
    'ECONNREFUSED',
    'ECONNRESET',
    'ETIMEDOUT',
    'ENOTFOUND',
    'EAI_AGAIN',
    'EHOSTUNREACH',
    'ENETUNREACH',
  ];
  const detail = status
    ? `HTTP ${status[1] ?? status[2]}`
    : network.find((value) => state.detail === value);
  if (detail) message += ` [CLI: ${detail}]`;
  return { code, message };
}
