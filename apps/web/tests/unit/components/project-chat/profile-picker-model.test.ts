import type { AgentProfile, ProfilePickerState } from '@simple-agent-manager/shared';
import { describe, expect, it } from 'vitest';

import {
  idleProfiles,
  modelLabel,
  pickerSections,
  profileCardSet,
  profileGlyph,
  profileSubtitle,
  selectProfileId,
} from '../../../../src/components/project-chat/profile-picker/model';

function profile(id: string, overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    id,
    projectId: 'p1',
    userId: 'u1',
    name: id,
    description: null,
    agentType: 'claude-code',
    model: null,
    effort: 'auto',
    permissionMode: null,
    systemPromptAppend: null,
    maxTurns: null,
    timeoutMinutes: null,
    vmSizeOverride: null,
    provider: null,
    vmLocation: null,
    workspaceProfile: null,
    runtime: null,
    devcontainerConfigName: null,
    taskMode: 'conversation',
    githubCliPolicy: null,
    isBuiltin: false,
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-01T00:00:00Z',
    ...overrides,
  };
}

// Alphabetical order, as GET .../agent-profiles returns them.
const ALPHA = profile('alpha');
const BUILDER = profile('builder', { taskMode: 'task', agentType: 'openai-codex' });
const OPUS = profile('opus', { model: 'claude-opus-5-5', effort: 'max' });
const ZED = profile('zed', { agentType: 'openai-codex', model: 'gpt-6.1-sol' });
const ALL = [ALPHA, BUILDER, OPUS, ZED];

function state(overrides: Partial<ProfilePickerState> = {}): ProfilePickerState {
  return { usage: [], hiddenProfileIds: [], usageWindowDays: 30, ...overrides };
}

const usage = (...ids: string[]) =>
  ids.map((profileId, index) => ({
    profileId,
    lastUsedAt: `2026-10-${String(20 - index).padStart(2, '0')}T00:00:00Z`,
    chatCount: 1,
  }));

describe('profile labels', () => {
  it('names what will run in plain words', () => {
    expect(profileSubtitle(OPUS)).toBe('Claude · Opus 5.5 · max effort');
    expect(profileSubtitle(ALPHA)).toBe('Claude');
    expect(modelLabel(profile('x', { agentType: 'opencode', model: 'opencode-go/kimi-k3' }))).toBe(
      'Kimi K3'
    );
    // Unknown to the catalog: fall back to the raw id after the provider prefix.
    expect(
      modelLabel(profile('y', { agentType: 'opencode', model: 'opencode-go/mystery-9' }))
    ).toBe('mystery-9');
  });

  it('gives models distinct initials, skipping the GPT prefix', () => {
    expect(profileGlyph(OPUS)).toBe('O');
    expect(profileGlyph(ZED)).toBe('S');
    expect(profileGlyph(ALPHA)).toBe('C');
    expect(profileGlyph(profile('u', { model: 'élan-1' }))).toBe('É');
  });
});

describe('selectProfileId', () => {
  it('waits for picker state instead of guessing the alphabetical first', () => {
    expect(selectProfileId(null, ALL, { status: 'loading' })).toBeNull();
  });

  it('picks the last-used visible profile once picker state is ready', () => {
    const ready = { status: 'ready' as const, state: state({ usage: usage('zed', 'opus') }) };
    expect(selectProfileId(null, ALL, ready)).toBe('zed');
  });

  it('skips a hidden last-used profile', () => {
    const ready = {
      status: 'ready' as const,
      state: state({ usage: usage('zed', 'opus'), hiddenProfileIds: ['zed'] }),
    };
    expect(selectProfileId(null, ALL, ready)).toBe('opus');
  });

  it('falls back to the first visible profile, then the first profile', () => {
    expect(
      selectProfileId(null, ALL, { status: 'ready', state: state({ hiddenProfileIds: ['alpha'] }) })
    ).toBe('builder');
    expect(
      selectProfileId(null, [ALPHA], {
        status: 'ready',
        state: state({ hiddenProfileIds: ['alpha'] }),
      })
    ).toBe('alpha');
    expect(selectProfileId(null, ALL, { status: 'unavailable' })).toBe('alpha');
  });

  it('still pre-selects a profile when every one is hidden, since hidden profiles stay usable', () => {
    const allHidden = state({ hiddenProfileIds: ALL.map((p) => p.id) });
    expect(selectProfileId(null, ALL, { status: 'ready', state: allHidden })).toBe('alpha');
    expect(profileCardSet(ALL, allHidden, 4).items).toEqual([]);
  });

  it('skips usage of a profile that has since been deleted', () => {
    const picker = state({ usage: usage('deleted-profile', 'opus') });
    expect(selectProfileId(null, ALL, { status: 'ready', state: picker })).toBe('opus');
    expect(profileCardSet(ALL, picker, 4).items.map((p) => p.id)).toEqual(['opus']);
    expect(pickerSections(ALL, picker, '', 3)[0]).toEqual({
      id: 'recent',
      label: 'Recent',
      items: [OPUS],
    });
  });

  it('never replaces a profile the person already chose', () => {
    const ready = { status: 'ready' as const, state: state({ usage: usage('zed') }) };
    expect(selectProfileId('opus', ALL, ready)).toBe('opus');
    // ...unless it no longer exists.
    expect(selectProfileId('deleted', ALL, ready)).toBe('zed');
  });
});

describe('profileCardSet', () => {
  it('shows recent profiles first and builders not already shown', () => {
    const cards = profileCardSet(ALL, state({ usage: usage('zed', 'opus') }), 4);
    expect(cards.kind).toBe('recent');
    expect(cards.items.map((p) => p.id)).toEqual(['zed', 'opus']);
    expect(cards.builders.map((p) => p.id)).toEqual(['builder']);
  });

  it('shows the first profiles when there is no recent use, leaving hidden ones out', () => {
    const cards = profileCardSet(ALL, state({ hiddenProfileIds: ['builder'] }), 2);
    expect(cards.kind).toBe('profiles');
    expect(cards.items.map((p) => p.id)).toEqual(['alpha', 'opus']);
    expect(cards.builders).toEqual([]);
  });
});

describe('pickerSections', () => {
  it('groups recent, chat, build and hidden profiles without repeats', () => {
    const sections = pickerSections(
      ALL,
      state({ usage: usage('opus'), hiddenProfileIds: ['zed'] }),
      '',
      3
    );
    expect(sections.map((section) => [section.id, section.items.map((p) => p.id)])).toEqual([
      ['recent', ['opus']],
      ['chat', ['alpha']],
      ['build', ['builder']],
      ['hidden', ['zed']],
    ]);
  });

  it('searches names and plain-language subtitles', () => {
    const sections = pickerSections(ALL, state(), 'opus 5.5', 3);
    expect(sections).toEqual([{ id: 'results', label: 'Results', items: [OPUS] }]);
  });
});

describe('idleProfiles', () => {
  it('suggests hiding visible profiles not used in the window', () => {
    expect(idleProfiles(ALL, state({ usage: usage('opus') })).map((p) => p.id)).toEqual([
      'alpha',
      'builder',
      'zed',
    ]);
  });

  it('suggests nothing without usage, so a new person is never told to hide everything', () => {
    expect(idleProfiles(ALL, state())).toEqual([]);
    expect(idleProfiles(ALL, undefined)).toEqual([]);
  });
});
