export const DEPLOYMENT_TOOLS = [
  {
    name: 'list_deployment_environments',
    description:
      'List active deployment environments this agent is allowed to access in the current project. Only environments with agent deployment enabled and compatible with this agent profile are returned.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'read_deployment_logs',
    description:
      'Read logs from an accessible deployment environment. Supports the same deployment-node log filters as the Deployments UI. Requires the named environment to allow this agent profile.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        environment: {
          type: 'string',
          description: 'Deployment environment name, such as "staging" or "production".',
        },
        source: {
          type: 'string',
          enum: ['all', 'agent', 'cloud-init', 'docker', 'systemd'],
          description: 'Optional log source filter. Defaults to the deployment node default.',
        },
        level: {
          type: 'string',
          enum: ['debug', 'info', 'warn', 'error'],
          description: 'Optional log level filter.',
        },
        container: {
          type: 'string',
          description: 'Optional Docker container name filter when source is docker.',
        },
        since: {
          type: 'string',
          description: 'Optional lower time bound, as ISO 8601 or a VM-agent relative value like "-1h".',
        },
        until: {
          type: 'string',
          description: 'Optional upper time bound as ISO 8601.',
        },
        search: {
          type: 'string',
          description: 'Optional substring search against log messages.',
        },
        cursor: {
          type: 'string',
          description: 'Optional pagination cursor returned by a previous log response.',
        },
        limit: {
          type: 'number',
          description:
            'Optional max log entries to return. Clamped by MCP_DEPLOYMENT_LOG_MAX_LIMIT and the deployment node log reader.',
        },
      },
      required: ['environment'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_deployment_environment_config',
    description:
      'List Variables and Secrets configured for an accessible deployment environment. Variable values are visible. Secret values are never returned; only secret keys and metadata are shown.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        environment: {
          type: 'string',
          description: 'Deployment environment name, such as "staging" or "production".',
        },
      },
      required: ['environment'],
      additionalProperties: false,
    },
  },
  {
    name: 'set_deployment_environment_config',
    description:
      'Create or update a Variable or Secret for an accessible deployment environment. Secret values are encrypted by SAM and are not returned after save.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        environment: {
          type: 'string',
          description: 'Deployment environment name, such as "staging" or "production".',
        },
        key: {
          type: 'string',
          description: 'Environment variable key. Must match [A-Za-z_][A-Za-z0-9_]*.',
        },
        value: {
          type: 'string',
          description: 'Value to store. For secrets this value is write-only and will not be returned.',
        },
        isSecret: {
          type: 'boolean',
          description: 'When true, encrypt the value and return only masked secret metadata.',
        },
      },
      required: ['environment', 'key', 'value'],
      additionalProperties: false,
    },
  },
] as const;
