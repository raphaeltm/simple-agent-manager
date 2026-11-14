/**
 * Profile pins and run accounts: the most specific tiers of agent credential resolution.
 *
 *   run account → profile pin → project pin → user default → platform
 *
 * Each case builds a realistic snapshot that also contains a project pin, a
 * default and a platform default (and, for run accounts, a profile pin), so a test
 * can only pass when the tier under test is what decided.
 */
import { describe, expect, it } from 'vitest';

import { explainResolution, resolveEnvironment } from '../../src/composable-credentials/resolver';
import type {
  Attachment,
  CompositionSnapshot,
  Configuration,
  ConsumerRef,
  Credential,
} from '../../src/composable-credentials/types';

const ME = 'user-me';
const OTHER = 'user-other';
const PROJECT = 'project-1';
const PROFILE = 'profile-opus';
const CLAUDE: ConsumerRef = { kind: 'agent', agentType: 'claude-code' };
const CODEX: ConsumerRef = { kind: 'agent', agentType: 'openai-codex' };

function credential(id: string, ownerId = ME, isActive = true): Credential {
  return {
    id,
    ownerId,
    name: id,
    kind: 'oauth-token',
    secret: { kind: 'oauth-token', token: `${id}-token` },
    isActive,
  };
}

function configuration(
  id: string,
  credentialId: string,
  consumer: ConsumerRef = CLAUDE,
  isActive = true,
  ownerId = ME
): Configuration {
  return { id, ownerId, name: id, consumer, credentialId, settings: {}, isActive };
}

function attachment(
  id: string,
  configurationId: string,
  target: Attachment['target'],
  consumer: ConsumerRef = CLAUDE,
  isActive = true
): Attachment {
  return { id, configurationId, consumer, target, isActive };
}

/** Default, project pin, profile pin and platform default all present. */
function fullSnapshot(overrides?: {
  profilePinActive?: boolean;
  profileConfigActive?: boolean;
  profileCredentialActive?: boolean;
  runConfigActive?: boolean;
  runCredentialActive?: boolean;
}): CompositionSnapshot {
  return {
    credentials: [
      credential('cred-default'),
      credential('cred-project'),
      credential('cred-max', ME, overrides?.profileCredentialActive ?? true),
      credential('cred-run', ME, overrides?.runCredentialActive ?? true),
      credential('cred-codex'),
    ],
    configurations: [
      configuration('cfg-default', 'cred-default'),
      configuration('cfg-project', 'cred-project'),
      configuration('cfg-max', 'cred-max', CLAUDE, overrides?.profileConfigActive ?? true),
      configuration('cfg-run', 'cred-run', CLAUDE, overrides?.runConfigActive ?? true),
      configuration('cfg-codex', 'cred-codex', CODEX),
    ],
    attachments: [
      attachment('att-default', 'cfg-default', { scope: 'user', userId: ME }),
      attachment('att-project', 'cfg-project', {
        scope: 'project',
        userId: ME,
        projectId: PROJECT,
      }),
      attachment(
        'att-profile',
        'cfg-max',
        { scope: 'profile', userId: ME, profileId: PROFILE },
        CLAUDE,
        overrides?.profilePinActive ?? true
      ),
    ],
    platform: {
      'agent:claude-code': {
        mode: 'credential',
        credential: credential('platform', '__platform__'),
      },
    },
  };
}

const profileCtx = {
  userId: ME,
  projectId: PROJECT,
  profileId: PROFILE,
  profileAgentType: 'claude-code',
};

describe('profile pins in resolveEnvironment', () => {
  it('an active profile pin wins over the project pin and the default', () => {
    const resolved = resolveEnvironment(fullSnapshot(), CLAUDE, profileCtx);
    expect(resolved?.source).toBe('profile-attachment');
    expect(resolved?.credential?.id).toBe('cred-max');
  });

  it('a paused profile pin halts: no project pin, default or platform fallback', () => {
    const trace = explainResolution(fullSnapshot({ profilePinActive: false }), CLAUDE, profileCtx);
    expect(trace.resolved).toBeNull();
    expect(trace.halted).toBe(true);
    expect(trace.steps.map((s) => [s.tier, s.state, s.reason])).toEqual([
      ['profile', 'halted', 'paused'],
      ['project', 'not-reached', null],
      ['user', 'not-reached', null],
      ['platform', 'not-reached', null],
    ]);
  });

  it.each([
    ['configuration', { profileConfigActive: false }, 'configuration-inactive'],
    ['credential', { profileCredentialActive: false }, 'credential-inactive'],
  ] as const)('a profile pin whose %s is paused halts', (_label, overrides, reason) => {
    const trace = explainResolution(fullSnapshot(overrides), CLAUDE, profileCtx);
    expect(trace.resolved).toBeNull();
    expect(trace.halted).toBe(true);
    expect(trace.steps[0]).toMatchObject({ tier: 'profile', state: 'halted', reason });
  });

  it('a pin for another agent type than the run is skipped and the chain continues', () => {
    // The profile is Claude, but a skill switches the run to Codex.
    const snapshot = fullSnapshot();
    snapshot.configurations.push(configuration('cfg-codex-project', 'cred-project', CODEX));
    snapshot.attachments.push(
      attachment(
        'att-codex-project',
        'cfg-codex-project',
        { scope: 'project', userId: ME, projectId: PROJECT },
        CODEX
      )
    );
    const trace = explainResolution(snapshot, CODEX, {
      ...profileCtx,
      profileAgentType: 'openai-codex',
    });
    expect(trace.resolved?.source).toBe('project-attachment');
    expect(trace.steps[0]).toMatchObject({
      tier: 'profile',
      state: 'skipped',
      reason: 'agent-type-mismatch',
      pinnedAgentType: 'claude-code',
      attachmentId: 'att-profile',
    });
  });

  it('a pin matching the consumer is skipped when the running agent is a different one', () => {
    // Stale pin left on the profile, queried by a caller that tries several agent types.
    const trace = explainResolution(fullSnapshot(), CLAUDE, {
      ...profileCtx,
      profileAgentType: 'openai-codex',
    });
    expect(trace.resolved?.source).toBe('project-attachment');
    expect(trace.steps[0]).toMatchObject({ state: 'skipped', reason: 'agent-type-mismatch' });
  });

  it('a paused pin for another agent type does not halt the running agent', () => {
    const snapshot = fullSnapshot({ profilePinActive: false });
    const resolved = resolveEnvironment(snapshot, CODEX, {
      ...profileCtx,
      profileAgentType: 'openai-codex',
    });
    expect(resolved).toBeNull(); // no Codex account anywhere: unresolved, not halted
    const trace = explainResolution(snapshot, CODEX, {
      ...profileCtx,
      profileAgentType: 'openai-codex',
    });
    expect(trace.halted).toBe(false);
  });

  it('without a profile pin, resolution is exactly what it was before', () => {
    const snapshot = fullSnapshot();
    snapshot.attachments = snapshot.attachments.filter((a) => a.target.scope !== 'profile');
    const withProfile = resolveEnvironment(snapshot, CLAUDE, profileCtx);
    const withoutProfile = resolveEnvironment(snapshot, CLAUDE, { userId: ME, projectId: PROJECT });
    expect(withProfile).toEqual(withoutProfile);
    expect(withProfile?.source).toBe('project-attachment');
    expect(explainResolution(snapshot, CLAUDE, profileCtx).steps[0]).toMatchObject({
      tier: 'profile',
      state: 'not-set',
    });
  });

  it('without profile context, a profile pin is ignored entirely', () => {
    const resolved = resolveEnvironment(fullSnapshot(), CLAUDE, { userId: ME, projectId: PROJECT });
    expect(resolved?.source).toBe('project-attachment');
    const trace = explainResolution(fullSnapshot(), CLAUDE, { userId: ME, projectId: PROJECT });
    expect(trace.steps.map((s) => s.tier)).toEqual(['project', 'user', 'platform']);
  });

  it('a global profile (no project) pin wins over the default', () => {
    const resolved = resolveEnvironment(fullSnapshot(), CLAUDE, {
      userId: ME,
      profileId: PROFILE,
      profileAgentType: 'claude-code',
    });
    expect(resolved?.source).toBe('profile-attachment');
    expect(resolved?.credential?.id).toBe('cred-max');
  });

  it("another user's pin on the same profile never applies to me", () => {
    const snapshot = fullSnapshot();
    snapshot.attachments = snapshot.attachments.map((a) =>
      a.target.scope === 'profile' ? { ...a, target: { ...a.target, userId: OTHER } } : a
    );
    const resolved = resolveEnvironment(snapshot, CLAUDE, profileCtx);
    expect(resolved?.source).toBe('project-attachment');
    expect(resolved?.credential?.id).toBe('cred-project');
  });

  it('a pin on a different profile does not apply', () => {
    const resolved = resolveEnvironment(fullSnapshot(), CLAUDE, {
      ...profileCtx,
      profileId: 'other',
    });
    expect(resolved?.source).toBe('project-attachment');
  });

  it('compute consumers never consult the profile tier', () => {
    const compute: ConsumerRef = { kind: 'compute', provider: 'hetzner' };
    const trace = explainResolution(fullSnapshot(), compute, profileCtx);
    expect(trace.steps.map((s) => s.tier)).toEqual(['project', 'user', 'platform']);
  });

  it('records each tier: used profile pin, the rest not reached', () => {
    const trace = explainResolution(fullSnapshot(), CLAUDE, profileCtx);
    expect(trace.halted).toBe(false);
    expect(trace.steps.map((s) => [s.tier, s.state])).toEqual([
      ['profile', 'used'],
      ['project', 'not-reached'],
      ['user', 'not-reached'],
      ['platform', 'not-reached'],
    ]);
  });

  it('records a paused default as skipped, then the platform as used', () => {
    const snapshot = fullSnapshot();
    snapshot.attachments = snapshot.attachments
      .filter((a) => a.target.scope === 'user')
      .map((a) => ({ ...a, isActive: false }));
    const trace = explainResolution(snapshot, CLAUDE, profileCtx);
    expect(trace.resolved?.source).toBe('platform');
    expect(trace.steps.map((s) => [s.tier, s.state, s.reason])).toEqual([
      ['profile', 'not-set', null],
      ['project', 'not-set', null],
      ['user', 'skipped', 'paused'],
      ['platform', 'used', null],
    ]);
  });
});

const runCtx = (runConfigurationId: string) => ({ ...profileCtx, runConfigurationId });

describe('run accounts in explainResolution', () => {
  it('the chosen account wins over the profile pin, project pin and default', () => {
    const trace = explainResolution(fullSnapshot(), CLAUDE, runCtx('cfg-run'));
    expect(trace.resolved?.source).toBe('run-override');
    expect(trace.resolved?.credential?.id).toBe('cred-run');
    expect(trace.steps.map((step) => [step.tier, step.state])).toEqual([
      ['run', 'used'],
      ['profile', 'not-reached'],
      ['project', 'not-reached'],
      ['user', 'not-reached'],
      ['platform', 'not-reached'],
    ]);
  });

  it('control: without a choice the profile pin decides', () => {
    expect(resolveEnvironment(fullSnapshot(), CLAUDE, profileCtx)?.source).toBe(
      'profile-attachment'
    );
  });

  it('applies without a profile', () => {
    const resolved = resolveEnvironment(fullSnapshot(), CLAUDE, {
      userId: ME,
      projectId: PROJECT,
      runConfigurationId: 'cfg-run',
    });
    expect(resolved?.credential?.id).toBe('cred-run');
  });

  it.each([
    ['a paused configuration', { runConfigActive: false }, 'cfg-run', 'configuration-inactive'],
    ['a paused credential', { runCredentialActive: false }, 'cfg-run', 'credential-inactive'],
    ['a missing configuration', {}, 'cfg-gone', 'configuration-missing'],
  ] as const)('%s halts instead of falling back', (_name, overrides, id, reason) => {
    const trace = explainResolution(fullSnapshot(overrides), CLAUDE, runCtx(id));
    expect(trace.resolved).toBeNull();
    expect(trace.halted).toBe(true);
    expect(trace.steps[0]).toMatchObject({ tier: 'run', state: 'halted', reason });
  });

  it('another person’s configuration halts even when a snapshot holds it', () => {
    const snapshot = fullSnapshot();
    snapshot.credentials.push(credential('cred-theirs', OTHER));
    snapshot.configurations.push(configuration('cfg-theirs', 'cred-theirs', CLAUDE, true, OTHER));
    const trace = explainResolution(snapshot, CLAUDE, runCtx('cfg-theirs'));
    expect(trace.resolved).toBeNull();
    expect(trace.halted).toBe(true);
    expect(trace.steps[0]).toMatchObject({ reason: 'configuration-missing' });
  });

  it('my configuration over another person’s credential halts', () => {
    const snapshot = fullSnapshot();
    snapshot.credentials.push(credential('cred-theirs', OTHER));
    snapshot.configurations.push(configuration('cfg-mine-theirs', 'cred-theirs'));
    const trace = explainResolution(snapshot, CLAUDE, runCtx('cfg-mine-theirs'));
    expect(trace.resolved).toBeNull();
    expect(trace.steps[0]).toMatchObject({ reason: 'credential-missing' });
  });

  it('an account for another agent is skipped, so that agent keeps its usual account', () => {
    // Chosen for Claude; a Codex session in the same workspace resolves as before.
    const trace = explainResolution(fullSnapshot(), CODEX, runCtx('cfg-run'));
    expect(trace.halted).toBe(false);
    expect(trace.steps[0]).toMatchObject({
      tier: 'run',
      state: 'skipped',
      reason: 'agent-type-mismatch',
      pinnedAgentType: 'claude-code',
    });
  });

  it('never applies to compute consumers', () => {
    const trace = explainResolution(
      fullSnapshot(),
      { kind: 'compute', provider: 'hetzner' },
      runCtx('cfg-run')
    );
    expect(trace.steps.some((step) => step.tier === 'run')).toBe(false);
  });
});
