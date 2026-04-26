/**
 * Unit tests for mailbox shared types, constants, and migration safety.
 */
import {
  DELIVERY_STATE_TRANSITIONS,
  DELIVERY_STATES,
  DELIVERY_TERMINAL_STATES,
  DURABLE_MESSAGE_CLASSES,
  MAILBOX_DEFAULTS,
  MESSAGE_CLASSES,
  SENDER_TYPES,
} from '@simple-agent-manager/shared';
import { describe, expect, it } from 'vitest';

import { MIGRATIONS } from '../../../src/durable-objects/migrations';

describe('Mailbox Types and Constants', () => {
  it('defines 5 message classes in escalating order', () => {
    expect(MESSAGE_CLASSES).toEqual([
      'notify',
      'deliver',
      'interrupt',
      'preempt_and_replan',
      'shutdown_with_final_prompt',
    ]);
  });

  it('defines 4 delivery states', () => {
    expect(DELIVERY_STATES).toEqual(['queued', 'delivered', 'acked', 'expired']);
  });

  it('defines terminal states as acked and expired', () => {
    expect(DELIVERY_TERMINAL_STATES).toEqual(['acked', 'expired']);
  });

  it('defines durable classes as all except notify', () => {
    expect(DURABLE_MESSAGE_CLASSES).toEqual([
      'deliver',
      'interrupt',
      'preempt_and_replan',
      'shutdown_with_final_prompt',
    ]);
  });

  it('defines valid state transitions', () => {
    // queued can go to delivered or expired
    expect(DELIVERY_STATE_TRANSITIONS.queued).toContain('delivered');
    expect(DELIVERY_STATE_TRANSITIONS.queued).toContain('expired');

    // delivered can go to acked or expired
    expect(DELIVERY_STATE_TRANSITIONS.delivered).toContain('acked');
    expect(DELIVERY_STATE_TRANSITIONS.delivered).toContain('expired');

    // acked and expired are terminal — no transitions allowed
    expect(DELIVERY_STATE_TRANSITIONS.acked).toEqual([]);
    expect(DELIVERY_STATE_TRANSITIONS.expired).toEqual([]);
  });

  it('defines sender types', () => {
    expect(SENDER_TYPES).toContain('agent');
    expect(SENDER_TYPES).toContain('orchestrator');
    expect(SENDER_TYPES).toContain('system');
    expect(SENDER_TYPES).toContain('human');
  });

  it('has reasonable default values', () => {
    expect(MAILBOX_DEFAULTS.ACK_TIMEOUT_MS).toBe(300_000); // 5 min
    expect(MAILBOX_DEFAULTS.REDELIVERY_MAX_ATTEMPTS).toBe(5);
    expect(MAILBOX_DEFAULTS.TTL_MS).toBe(3_600_000); // 1 hour
    expect(MAILBOX_DEFAULTS.DELIVERY_POLL_INTERVAL_MS).toBe(30_000); // 30 sec
    expect(MAILBOX_DEFAULTS.MAX_MESSAGES_PER_PROJECT).toBe(1_000);
    expect(MAILBOX_DEFAULTS.MESSAGE_MAX_LENGTH).toBe(32_768);
  });
});

describe('Migration 017 Safety', () => {
  it('migration 017 exists in the MIGRATIONS array', () => {
    const m017 = MIGRATIONS.find((m) => m.name === '017-agent-mailbox');
    expect(m017).toBeDefined();
    expect(typeof m017!.run).toBe('function');
  });

  it('migration 017 uses ALTER TABLE (verified by name and run function)', () => {
    const m017 = MIGRATIONS.find((m) => m.name === '017-agent-mailbox');
    expect(m017).toBeDefined();
    // The run function source should contain ALTER TABLE, not DROP TABLE
    const source = m017!.run.toString();
    expect(source).toContain('ALTER TABLE');
    expect(source.toUpperCase()).not.toContain('DROP TABLE');
  });

  it('migration 017 adds required columns', () => {
    const m017 = MIGRATIONS.find((m) => m.name === '017-agent-mailbox');
    expect(m017).toBeDefined();
    const source = m017!.run.toString();
    expect(source).toContain('message_class');
    expect(source).toContain('delivery_state');
    expect(source).toContain('sender_type');
    expect(source).toContain('ack_required');
    expect(source).toContain('ack_timeout_ms');
    expect(source).toContain('expires_at');
    expect(source).toContain('delivery_attempts');
    expect(source).toContain('metadata');
  });

  it('migration 017 creates delivery sweep indexes', () => {
    const m017 = MIGRATIONS.find((m) => m.name === '017-agent-mailbox');
    expect(m017).toBeDefined();
    const source = m017!.run.toString();
    expect(source).toContain('idx_inbox_delivery_sweep');
    expect(source).toContain('idx_inbox_target_state');
  });
});
