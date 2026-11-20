/**
 * MCP tool definitions — private incident backlog tools.
 */
import { INCIDENT_QUEUE_STATES } from '../../services/platform-feedback-incidents';

export const INCIDENT_TOOLS = [
  {
    name: 'list_incident_queue',
    description:
      'List grouped private incidents in the configured Operations project. ' +
      'The server derives project scope from the MCP token and returns bounded metadata only. ' +
      'Defaults to pending, dispatched and claimed. Pass state "watching" with sort "frequency" to rank watched signatures: ' +
      'each item carries occurrenceCount, firstSeenAt, lastSeenAt, recentOccurrenceCount (occurrences while watching in the last recentWindowHours), ' +
      'watchingSince, watchReason, watchEscalatedAt and watchEscalationReason.',
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
        sort: {
          type: 'string',
          description:
            'Order: "priority" (default: severity, novelty, fewest occurrences) or "frequency" (most recent occurrences first, then total occurrences).',
          enum: ['priority', 'frequency'],
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
      'Resolve, reject or watch a claimed private incident. ' +
      'Requires the claim token returned by claim_incident and the same task-scoped MCP token. ' +
      'Resolved outcomes require one ship-or-track reference: fixPrUrl, dispatchedTaskId, or linkedRecordId. ' +
      'Rejected outcomes require a justification note but no fix reference. ' +
      'Watching is for a genuine defect that is not urgent: it requires a one-line reason in note; recurrences then only update the ' +
      "signature's counts and idea (no re-triage), a spike returns it to the queue, and a quiet period expires it.",
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
          description:
            'Outcome: resolved and rejected end the incident; watching keeps measuring it.',
          enum: ['resolved', 'rejected', 'watching'],
        },
        note: {
          type: 'string',
          description:
            'Short private resolution note. Required for rejected outcomes, and the one-line watch reason for watching. The server redacts and bounds it.',
        },
        fixPrUrl: {
          type: 'string',
          description:
            'Optional merged or open pull request URL that ships or tracks the fix for a resolved incident.',
        },
        dispatchedTaskId: {
          type: 'string',
          description:
            'Optional SAM implementation task ID dispatched to ship the fix for a resolved incident.',
        },
        linkedRecordId: {
          type: 'string',
          description:
            'Optional existing SAM Idea/task ID that tracks the fix for a resolved incident.',
        },
      },
      required: ['incidentId', 'claimToken', 'outcome'],
      additionalProperties: false,
    },
  },
];
