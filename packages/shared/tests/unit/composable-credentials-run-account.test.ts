/**
 * Run accounts: the account a person chose for one run, checked before every pin.
 *
 *   run account → profile pin → project pin → user default → platform
 *
 * Each case uses a snapshot that also holds a profile pin, a project pin, a default and a
 * platform default, so a test can only pass when the run tier is what decided.
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
    ['an account for another agent', {}, 'cfg-codex', 'agent-type-mismatch'],
  ] as const)('%s halts instead of falling back', (_name, overrides, id, reason) => {
    const trace = explainResolution(fullSnapshot(overrides), CLAUDE, runCtx(id));
    expect(trace.resolved).toBeNull();
    expect(trace.halted).toBe(true);
    expect(trace.steps[0]).toMatchObject({ tier: 'run', state: 'halted', reason });
  });

  it('another person’s configuration is not in the snapshot, so it halts as missing', () => {
    const snapshot = fullSnapshot();
    // The API snapshot only loads the caller's configurations; one that leaked in under
    // another owner must still not be found by id from a different owner's run.
    snapshot.configurations = snapshot.configurations.filter((cfg) => cfg.id !== 'cfg-run');
    snapshot.configurations.push(configuration('cfg-theirs', 'cred-run', CLAUDE, true, OTHER));
    const trace = explainResolution(snapshot, CLAUDE, runCtx('cfg-run'));
    expect(trace.resolved).toBeNull();
    expect(trace.steps[0]).toMatchObject({ reason: 'configuration-missing' });
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
