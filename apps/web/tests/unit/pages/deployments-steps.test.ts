/**
 * Deploy steps from the apply events the VM agent reports. Event names follow
 * `packages/vm-agent/internal/deploy/engine.go`, including where the event prefix differs
 * from the step key (`artifacts_load` → `load_artifacts`).
 */
import { describe, expect, it } from 'vitest';

import type { DeploymentReleaseEvent } from '../../../src/lib/api';
import { collapseSteps, latestAttempt, stepLabel } from '../../../src/pages/deployments/steps';

let seq = 0;
function event(eventType: string, step: string | null, level = 'info'): DeploymentReleaseEvent {
  seq += 1;
  return {
    seq,
    level,
    eventType: `deployment.apply.${eventType}`,
    step,
    message: eventType,
    createdAt: `2026-10-23T09:00:${String(seq).padStart(2, '0')}Z`,
  };
}

const attempt = (): DeploymentReleaseEvent[] => [
  event('fetch_started', 'fetch_release'),
  event('fetch_completed', 'fetch_release'),
  event('payload_verified', 'verify_payload'),
  event('started', 'apply'),
  event('previous_down_started', 'previous_down'),
  event('previous_down_completed', 'previous_down'),
  event('artifacts_load_started', 'load_artifacts'),
  event('artifacts_load_completed', 'load_artifacts'),
  event('compose_up_started', 'compose_up'),
];

const labels = (rows: Array<{ step: string; state: 'done' | 'running' | 'failed' }>) =>
  rows.map((row) => `${row.state}: ${stepLabel(row.step, row.state)}`);

describe('collapseSteps', () => {
  it('follows a deploy in progress, one row per step', () => {
    expect(labels(collapseSteps(attempt(), false))).toEqual([
      'done: Got the new version',
      'done: Stopped the old version',
      'done: Loaded the images',
      'running: Starting the app…',
    ]);
  });

  it('marks the step that broke and a revert that worked', () => {
    const events = [
      ...attempt(),
      event('failed', 'failed', 'error'),
      event('revert_started', 'revert'),
      event('reverted', 'revert', 'warn'),
    ];
    expect(labels(collapseSteps(events, true))).toEqual([
      'done: Got the new version',
      'done: Stopped the old version',
      'done: Loaded the images',
      "failed: The app didn't start",
      'done: Put the previous version back',
    ]);
  });

  it('marks a revert that never reported back as failed once the apply is over', () => {
    const events = [
      ...attempt(),
      event('failed', 'failed', 'error'),
      event('revert_started', 'revert'),
    ];
    expect(labels(collapseSteps(events, true)).at(-1)).toBe(
      "failed: Couldn't put the previous version back"
    );
    // While the apply is still running, the same revert is in progress.
    expect(labels(collapseSteps(events, false)).at(-1)).toBe(
      'running: Putting the previous version back…'
    );
  });

  it('says where it stopped when the failing step had no events of its own', () => {
    const events = [
      event('fetch_started', 'fetch_release'),
      event('fetch_completed', 'fetch_release'),
      event('failed', 'failed', 'error'),
    ];
    expect(labels(collapseSteps(events, true))).toEqual([
      'done: Got the new version',
      'failed: Stopped partway',
    ]);
  });

  it('treats a failed teardown of the old version as a warning, not a failure', () => {
    const events = [
      event('previous_down_started', 'previous_down'),
      event('previous_down_failed', 'previous_down', 'warn'),
    ];
    expect(labels(collapseSteps(events, false))).toEqual(['done: Stopped the old version']);
  });

  it('shows only the newest attempt when the same release was applied again', () => {
    const first = [...attempt(), event('failed', 'failed', 'error')];
    const second = [event('fetch_started', 'fetch_release')];
    expect(latestAttempt([...first, ...second])).toEqual(second);
    expect(labels(collapseSteps([...first, ...second], false))).toEqual([
      'running: Getting the new version…',
    ]);
  });

  it('keeps the fetch that opened an apply with that apply', () => {
    const events = attempt();
    expect(latestAttempt(events)[0]?.eventType).toBe('deployment.apply.fetch_started');
  });

  it('leaves out a step the server skipped', () => {
    const events = [
      event('artifacts_load_started', 'load_artifacts'),
      event('artifacts_load_completed', 'load_artifacts'),
      event('compose_pull_skipped', 'compose_pull'),
      event('compose_up_started', 'compose_up'),
    ];
    expect(labels(collapseSteps(events, false))).toEqual([
      'done: Loaded the images',
      'running: Starting the app…',
    ]);
  });

  it('reads a real failed first deploy, as staging reported it', () => {
    // The newest attempt of a staging release (2026-10-24), event names and steps verbatim.
    const events = [
      event('fetch_started', 'fetch_release'),
      event('fetch_completed', 'fetch_release'),
      event('fetch_completed', 'fetch_release'),
      event('payload_verified', 'verify_payload'),
      event('started', 'apply'),
      event('release_written', 'write_release'),
      event('volume_mount_started', 'volume_mounts'),
      event('volume_mount_completed', 'volume_mounts'),
      event('volume_mounts_verified', 'volume_mounts'),
      event('artifacts_load_started', 'load_artifacts'),
      event('artifacts_load_completed', 'load_artifacts'),
      event('compose_config_started', 'compose_config'),
      event('compose_config_completed', 'compose_config'),
      event('compose_pull_skipped', 'compose_pull'),
      event('compose_up_started', 'compose_up'),
      event('compose_up_completed', 'compose_up'),
      event('health_check_started', 'health_check'),
      event('failed', 'failed', 'error'),
      event('cleanup_started', 'cleanup_failed_initial'),
      event('failed_initial', 'failed_initial', 'error'),
    ];
    expect(labels(collapseSteps(events, true))).toEqual([
      'done: Got the new version',
      'done: Attached the saved data',
      'done: Loaded the images',
      "done: Checked the app's setup",
      'done: Started the app',
      'failed: Failed its health check',
    ]);
  });
});
