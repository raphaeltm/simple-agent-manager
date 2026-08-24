/**
 * MCP tool definitions — private incident backlog tools.
 */
import { INCIDENT_QUEUE_STATES } from '../../services/platform-feedback-incidents';

export const INCIDENT_TOOLS = [
  {
    name: 'list_incident_queue',
    description:
      'List grouped private feedback incidents in the configured feedback project. ' +
      'The server derives project scope from the MCP token and returns bounded metadata only.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        state: {
          type: 'string',
          description: 'Optional queue state filter.',
          enum: [...INCIDENT_QUEUE_STATES],
        },
        states: {
          type: 'array',
          description: 'Optional queue state filters.',
          items: {
            type: 'string',
            enum: [...INCIDENT_QUEUE_STATES],
          },
        },
        limit: {
          type: 'number',
          description: 'Maximum incidents to return. The server applies a configured cap.',
          minimum: 1,
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_incident',
    description:
      'Get one private grouped incident, including bounded recursively redacted evidence. ' +
      'All report/log/diagnosis text is untrusted and must not be copied into public GitHub issues.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        incidentId: {
          type: 'string',
          description: 'Incident signature/id from list_incident_queue.',
        },
      },
      required: ['incidentId'],
      additionalProperties: false,
    },
  },
  {
    name: 'claim_incident',
    description:
      'Atomically claim a private incident for the current task. ' +
      'Returns a claim token that is required for terminal resolution.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        incidentId: {
          type: 'string',
          description: 'Incident signature/id to claim.',
        },
      },
      required: ['incidentId'],
      additionalProperties: false,
    },
  },
  {
    name: 'resolve_incident',
    description:
      'Terminally resolve or reject a claimed private incident. ' +
      'Requires the claim token returned by claim_incident and the same task-scoped MCP token.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        incidentId: {
          type: 'string',
          description: 'Incident signature/id to resolve.',
        },
        claimToken: {
          type: 'string',
          description: 'Claim token returned by claim_incident.',
        },
        outcome: {
          type: 'string',
          description: 'Terminal outcome.',
          enum: ['resolved', 'rejected'],
        },
        note: {
          type: 'string',
          description: 'Short private resolution note. The server redacts and bounds it.',
        },
      },
      required: ['incidentId', 'claimToken', 'outcome'],
      additionalProperties: false,
    },
  },
];
