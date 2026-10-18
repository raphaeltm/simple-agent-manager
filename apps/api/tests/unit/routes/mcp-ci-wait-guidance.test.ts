import type { ProjectEventFilterV1 } from '@simple-agent-manager/shared';
import { describe, expect, it } from 'vitest';

import { filterMatchesProjectEvent } from '../../../src/durable-objects/project-data/project-events-normalization';
import { buildEventingInstructions } from '../../../src/routes/mcp/instruction-eventing-guidance';
import { PROJECT_EVENT_SUBSCRIPTION_TOOLS } from '../../../src/routes/mcp/tool-definitions-event-subscription-tools';

const create = PROJECT_EVENT_SUBSCRIPTION_TOOLS[0];
const fields = create.inputSchema.properties.filter.properties;
const instructions = buildEventingInstructions({
  coordinationChannel: null,
  agentMessageChannelsEnabled: false,
}).join('\n');
const sha = '0123456789abcdef0123456789abcdef01234567';

describe('agent-facing CI wait contract', () => {
  it.each(['check_run', 'check_suite', 'workflow_run'])(
    'advertises a completion filter that matches %s, not a bare name or short SHA',
    (type) => {
      const eventType = `${type}.completed`;
      for (const text of [create.description, fields.eventType.description, instructions]) {
        expect(text).toContain(eventType);
      }
      const filter: ProjectEventFilterV1 = {
        version: 1,
        source: 'github',
        eventType,
        subjectType: 'commit',
        subjectId: sha,
      };
      const event = {
        source: 'github',
        eventType,
        subject: { type: 'commit', id: sha },
        severity: 'info' as const,
      };
      expect(filterMatchesProjectEvent(filter, event)).toBe(true);
      expect(filterMatchesProjectEvent({ ...filter, eventType: type }, event)).toBe(false);
      expect(filterMatchesProjectEvent({ ...filter, subjectId: sha.slice(0, 8) }, event)).toBe(
        false
      );
      expect(filterMatchesProjectEvent(filter, { ...event, eventType: `${type}.requested` })).toBe(
        false
      );
    }
  );

  it('requires full head identity and state reconciliation in both entry points', () => {
    for (const text of [create.description, instructions]) {
      expect(text).toContain('full 40-character PR head SHA');
      expect(text).toContain('immediately after subscribing');
      expect(text).toContain('after every resume');
      expect(text).toContain('create_project_schedule');
      expect(text).toContain('bounded fallback check');
    }
    expect(fields.subjectId.description).toContain('never an abbreviated SHA');
    expect(create.inputSchema.properties.expiresAt.description).toContain(
      'Expiry does not itself wake'
    );
  });

  it('makes expired subscriptions discoverable and limits repeated recovery', () => {
    expect(PROJECT_EVENT_SUBSCRIPTION_TOOLS[1].description).toContain('state "any"');
    expect(instructions).toContain('state "any"');
    expect(instructions).toContain('After one fallback without progress');
    expect(instructions).toContain('do not blindly renew');
    expect(instructions).toContain('Cancel only your obsolete');
    expect(instructions).toContain('new idempotency key for a changed filter');
    expect(instructions).toContain('report the exact blocker');
  });
});
