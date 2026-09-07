/**
 * Capability tests for mission state and handoff packets in ProjectData DO.
 *
 * Exercises the D1 → DO boundary: creates state entries and handoff packets
 * via DO RPC methods, then reads them back — proving the real SQLite storage
 * and DO lifecycle work end-to-end.
 */
import type { HandoffLimits, MissionStateLimits } from '@simple-agent-manager/shared';
import {
  DEFAULT_HANDOFF_MAX_ARTIFACT_REFS,
  DEFAULT_HANDOFF_MAX_FACTS,
  DEFAULT_HANDOFF_MAX_OPEN_QUESTIONS,
  DEFAULT_HANDOFF_MAX_SUGGESTED_ACTIONS,
  DEFAULT_HANDOFF_SUMMARY_MAX_LENGTH,
  DEFAULT_MISSION_MAX_HANDOFFS,
  DEFAULT_MISSION_MAX_STATE_ENTRIES,
  DEFAULT_MISSION_STATE_CONTENT_MAX_LENGTH,
  DEFAULT_MISSION_STATE_TITLE_MAX_LENGTH,
} from '@simple-agent-manager/shared';
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import type { ProjectData } from '../../src/durable-objects/project-data';

function getStub(projectId: string): DurableObjectStub<ProjectData> {
  const id = env.PROJECT_DATA.idFromName(projectId);
  return env.PROJECT_DATA.get(id) as DurableObjectStub<ProjectData>;
}

const STATE_LIMITS: MissionStateLimits = {
  maxStateEntries: DEFAULT_MISSION_MAX_STATE_ENTRIES,
  stateTitleMaxLength: DEFAULT_MISSION_STATE_TITLE_MAX_LENGTH,
  stateContentMaxLength: DEFAULT_MISSION_STATE_CONTENT_MAX_LENGTH,
};

const HANDOFF_LIMITS: HandoffLimits = {
  maxHandoffs: DEFAULT_MISSION_MAX_HANDOFFS,
  summaryMaxLength: DEFAULT_HANDOFF_SUMMARY_MAX_LENGTH,
  maxFacts: DEFAULT_HANDOFF_MAX_FACTS,
  maxOpenQuestions: DEFAULT_HANDOFF_MAX_OPEN_QUESTIONS,
  maxArtifactRefs: DEFAULT_HANDOFF_MAX_ARTIFACT_REFS,
  maxSuggestedActions: DEFAULT_HANDOFF_MAX_SUGGESTED_ACTIONS,
};

describe('ProjectData DO — Mission State', () => {
  it('creates and retrieves a mission state entry', async () => {
    const stub = getStub('mission-state-test-1');
    const missionId = 'mission-001';

    const entry = await stub.createMissionStateEntry(
      missionId, 'decision', 'Use REST API', 'Chose REST over GraphQL', 'task-001', STATE_LIMITS,
    );

    expect(entry.id).toBeTruthy();
    expect(typeof entry.id).toBe('string');

    // Read it back
    const entries = await stub.getMissionStateEntries(missionId, null);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.entryType).toBe('decision');
    expect(entries[0]!.title).toBe('Use REST API');
    expect(entries[0]!.content).toBe('Chose REST over GraphQL');
    expect(entries[0]!.sourceTaskId).toBe('task-001');
  });

  it('filters state entries by type', async () => {
    const stub = getStub('mission-state-test-2');
    const missionId = 'mission-002';

    await stub.createMissionStateEntry(missionId, 'fact', 'Fact 1', 'Content', null, STATE_LIMITS);
    await stub.createMissionStateEntry(missionId, 'risk', 'Risk 1', 'Content', null, STATE_LIMITS);
    await stub.createMissionStateEntry(missionId, 'fact', 'Fact 2', 'Content', null, STATE_LIMITS);

    const facts = await stub.getMissionStateEntries(missionId, 'fact');
    expect(facts).toHaveLength(2);
    expect(facts.every((e: { entryType: string }) => e.entryType === 'fact')).toBe(true);

    const risks = await stub.getMissionStateEntries(missionId, 'risk');
    expect(risks).toHaveLength(1);
  });

  it('updates a mission state entry', async () => {
    const stub = getStub('mission-state-test-3');
    const missionId = 'mission-003';

    const entry = await stub.createMissionStateEntry(
      missionId, 'assumption', 'SDK supports Go 1.24', null, null, STATE_LIMITS,
    );

    await stub.updateMissionStateEntry(entry.id, { title: 'SDK supports Go 1.25', content: 'Verified' }, STATE_LIMITS);

    const updated = await stub.getMissionStateEntry(entry.id);
    expect(updated).not.toBeNull();
    expect(updated!.title).toBe('SDK supports Go 1.25');
    expect(updated!.content).toBe('Verified');
  });

  it('deletes a mission state entry', async () => {
    const stub = getStub('mission-state-test-4');
    const missionId = 'mission-004';

    const entry = await stub.createMissionStateEntry(
      missionId, 'todo', 'Update docs', null, null, STATE_LIMITS,
    );

    const deleted = await stub.deleteMissionStateEntry(entry.id);
    expect(deleted).toBe(true);

    const entries = await stub.getMissionStateEntries(missionId, null);
    expect(entries).toHaveLength(0);
  });

  it('supports all 7 entry types', async () => {
    const stub = getStub('mission-state-test-5');
    const missionId = 'mission-005';
    const types = ['decision', 'assumption', 'fact', 'contract', 'artifact_ref', 'risk', 'todo'] as const;

    for (const entryType of types) {
      await stub.createMissionStateEntry(missionId, entryType, `Entry: ${entryType}`, null, null, STATE_LIMITS);
    }

    const all = await stub.getMissionStateEntries(missionId, null);
    expect(all).toHaveLength(7);
    const foundTypes = new Set(all.map((e: { entryType: string }) => e.entryType));
    for (const t of types) {
      expect(foundTypes.has(t)).toBe(true);
    }
  });
});

describe('ProjectData DO — Handoff Packets', () => {
  it('creates and retrieves a handoff packet', async () => {
    const stub = getStub('handoff-test-1');
    const missionId = 'mission-h01';

    const handoff = await stub.createHandoffPacket(
      missionId, 'task-from', 'task-to',
      'Completed API implementation',
      [{ key: 'api_version', value: 'v2' }],
      ['Should we add rate limiting?'],
      [{ type: 'pr', ref: 'PR #123' }],
      ['Add rate limiting', 'Write docs'],
      HANDOFF_LIMITS,
    );

    expect(handoff.id).toBeTruthy();

    // Read it back
    const packets = await stub.getHandoffPackets(missionId);
    expect(packets).toHaveLength(1);
    expect(packets[0]!.summary).toBe('Completed API implementation');
    expect(packets[0]!.fromTaskId).toBe('task-from');
    expect(packets[0]!.toTaskId).toBe('task-to');
  });

  it('retrieves a single handoff packet by ID', async () => {
    const stub = getStub('handoff-test-2');
    const missionId = 'mission-h02';

    const created = await stub.createHandoffPacket(
      missionId, 'task-a', null,
      'Summary text', [], [], [], [],
      HANDOFF_LIMITS,
    );

    const packet = await stub.getHandoffPacket(created.id);
    expect(packet).not.toBeNull();
    expect(packet!.id).toBe(created.id);
    expect(packet!.summary).toBe('Summary text');
  });

  it('retrieves handoff packets for a specific task', async () => {
    const stub = getStub('handoff-test-3');
    const missionId = 'mission-h03';

    // Create handoff TO task-b
    await stub.createHandoffPacket(
      missionId, 'task-a', 'task-b', 'For task B', [], [], [], [], HANDOFF_LIMITS,
    );
    // Create handoff TO task-c (should not appear)
    await stub.createHandoffPacket(
      missionId, 'task-a', 'task-c', 'For task C', [], [], [], [], HANDOFF_LIMITS,
    );

    const forB = await stub.getHandoffPacketsForTask('task-b');
    expect(forB).toHaveLength(1);
    expect(forB[0]!.summary).toBe('For task B');
  });

  it('stores and returns structured facts and artifact refs as JSON', async () => {
    const stub = getStub('handoff-test-4');
    const missionId = 'mission-h04';
    const facts = [
      { key: 'provider', value: 'hetzner' },
      { key: 'region', value: 'fsn1' },
    ];
    const artifactRefs = [
      { type: 'file', ref: 'src/index.ts' },
      { type: 'pr', ref: '#456' },
    ];

    const handoff = await stub.createHandoffPacket(
      missionId, 'task-x', null,
      'Done', facts, ['Q1?'], artifactRefs, ['Next step'],
      HANDOFF_LIMITS,
    );

    const packet = await stub.getHandoffPacket(handoff.id);
    expect(packet).not.toBeNull();

    // JSON round-trip integrity
    const parsedFacts = typeof packet!.facts === 'string' ? JSON.parse(packet!.facts) : packet!.facts;
    expect(parsedFacts).toHaveLength(2);
    expect(parsedFacts[0].key).toBe('provider');

    const parsedRefs = typeof packet!.artifactRefs === 'string' ? JSON.parse(packet!.artifactRefs) : packet!.artifactRefs;
    expect(parsedRefs).toHaveLength(2);
    expect(parsedRefs[1].ref).toBe('#456');
  });
});
