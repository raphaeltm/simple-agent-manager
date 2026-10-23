const jobSchema = {
  type: 'object' as const,
  properties: {
    jobId: { type: 'string', description: 'The jobId returned by exec_with_secrets.' },
  },
  required: ['jobId'],
  additionalProperties: false,
};
export const SECRET_EXEC_TOOLS = [
  {
    name: 'exec_with_secrets',
    description:
      'Run an arbitrary command in this session’s CURRENT live workspace container, as its user and with its live files/network. Supply managed secretNames, never secret values. Fresh managed secret envs are placeholders; only selected names receive values in this job. Use literal argv (no shell expansion) OR command plus explicit bash/sh. This is a NEW noninteractive process with no TTY or shell startup files: it does not inherit terminal exports, aliases, functions, activation or cwd; source setup explicitly and set cwd (absolute, default session worktree). Env overrides are nonsecret only; ENV/BASH_ENV startup controls are reserved and rejected. Returns a durable jobId: poll exec_with_secrets_status until terminal and use exec_with_secrets_cancel to stop. Output is bounded and exact selected values are redacted; transformed values and files are not protected. Legacy active sessions may still have secrets; see execution.environmentMode. Requires bash and setsid in the existing container; never recreates or wakes it. Background external side effects such as docker compose -d can persist. Harness/MCP/Git credentials and secret files remain outside this env-only mediation.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        argv: { type: 'array', items: { type: 'string' }, minItems: 1 },
        command: { type: 'string' },
        shell: { type: 'string', enum: ['bash', 'sh'] },
        secretNames: {
          type: 'array',
          items: { type: 'string' },
          description: 'Managed project/profile/skill secret environment names.',
        },
        oidc: {
          type: 'object',
          properties: {
            audience: {
              type: 'string',
              description:
                'Exact external service audience. Injects a short-lived SAM_OIDC_TOKEN into this command only; no stored secrets or GCP setup required.',
            },
          },
          required: ['audience'],
          additionalProperties: false,
        },
        cwd: { type: 'string' },
        env: { type: 'object', additionalProperties: { type: 'string' } },
        timeoutMs: { type: 'integer', minimum: 1 },
        idempotencyKey: {
          type: 'string',
          description:
            'Reuse for transport retries of the identical request. Changed inputs conflict.',
        },
      },
      required: ['secretNames'],
      additionalProperties: false,
    },
  },
  {
    name: 'exec_with_secrets_status',
    description:
      'Read the same-session durable execution snapshot. Status is running, completed, failed, cancelled, timed_out or interrupted (VM agent restarted). Terminal output is bounded/redacted before persistence. Running snapshots have empty output. Jobs never replay automatically.',
    inputSchema: jobSchema,
  },
  {
    name: 'exec_with_secrets_cancel',
    description:
      'Idempotently request cancellation of a same-session execution job and its in-container process group. Poll status until terminal; the immediate snapshot can still be running. Detached external side effects may persist.',
    inputSchema: jobSchema,
  },
];
