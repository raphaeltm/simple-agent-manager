// Guards the package's public surface: the worker's re-export files and wiring depend on these
// names being reachable from the declared entry points.
import { describe, expect, it } from 'vitest';

import * as durableObject from '../../src/durable-object';
import * as main from '../../src/index';
import * as scheduled from '../../src/scheduled';

describe('project-data entry points', () => {
  it('exposes the client, ports and helpers from the main entry point', () => {
    for (const name of [
      'createSession',
      'persistMessage',
      'configureProjectDataPorts',
      'resolveProjectEventLimits',
      'scheduleLimits',
      'resolveStorageSafetyConfig',
      'readTaskAcpLivenessSignals',
      'decideAgentWake',
      'loadSharedSessionNames',
      'buildSessionLifecycleEventInput',
      'mapRows',
      'parseRowOrNull',
      'breakerWasClosedBeforeOpening',
    ]) {
      expect(main, name).toHaveProperty(name);
    }
  });

  it('exports the Durable Object class under its binding name', () => {
    expect(durableObject.ProjectData.name).toBe('ProjectData');
  });

  it('exposes the cron jobs from the scheduled entry point', () => {
    expect(typeof scheduled.runProjectDataArchiveSharding).toBe('function');
    expect(typeof scheduled.runProjectDataStorageReliefPreflight).toBe('function');
  });
});
