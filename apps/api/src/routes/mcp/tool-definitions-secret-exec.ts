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

export const SECRET_REQUEST_TOOLS = [
  {
    name: 'request_secret',
    description:
      "Ask a person to supply a secret value (API key, token, password) without it ever entering this conversation. Creates a request and shows a secure input card in the chat; a project owner or admin types the value there and SAM stores it encrypted as a project runtime secret named `name`. You never see the value: when it is supplied, declined or the request expires you get a short notice, then use it with exec_with_secrets and secretNames [name]. No restart is needed. Never ask for secret values in chat text or tool arguments; use this instead. Asking again for the same name in this chat returns the open request. Project secrets are shared: every project member's agent sessions can use them. Optional ttlSeconds makes the stored value expire (exec refuses it afterwards). Use list_runtime_env (workspace_read method runtime_env) first to see which names already exist.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: {
          type: 'string',
          description:
            'Environment variable name to store the value under, e.g. STRIPE_API_KEY ([A-Za-z_][A-Za-z0-9_]*).',
        },
        reason: {
          type: 'string',
          description:
            'Shown on the card: what the value is for and where the person can find it. Never include secret values.',
        },
        ttlSeconds: {
          type: 'integer',
          minimum: 1,
          description:
            'Optional lifetime of the stored value after it is supplied. Omit to keep it until someone deletes it.',
        },
      },
      required: ['name', 'reason'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_runtime_env',
    description:
      'List the managed runtime environment names this session can use, without values: project, agent profile and skill variables after precedence (skill over profile over project), whether each is a secret, its expiry, and for agent-collected secrets who supplied it and why. Secret names listed here are the ones exec_with_secrets accepts; expired values are omitted.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
      additionalProperties: false,
    },
  },
];
