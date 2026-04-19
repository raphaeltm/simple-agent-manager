import { describe, expect, it } from 'vitest';

import {
  friendlyStageLabel,
  STAGE_LABELS,
  STAGE_TIMELINE,
} from '../../../src/lib/trial-ui-config';

describe('friendlyStageLabel', () => {
  it('maps known orchestrator stages to friendly copy', () => {
    expect(friendlyStageLabel('creating_project')).toBe('Creating your project');
    expect(friendlyStageLabel('finding_node')).toBe('Finding a workspace host');
    expect(friendlyStageLabel('agent_booting')).toBe('Agent is booting up');
  });

  it('prettifies unknown snake_case stages', () => {
    expect(friendlyStageLabel('cloning_repository')).toBe('Cloning the repository');
    expect(friendlyStageLabel('some_new_stage')).toBe('Some New Stage');
  });

  it('prettifies kebab-case stages', () => {
    expect(friendlyStageLabel('reading-readme')).toBe('Reading Readme');
  });

  it('returns a calm fallback for empty/null/undefined', () => {
    expect(friendlyStageLabel(undefined)).toBe('Working on it');
    expect(friendlyStageLabel(null)).toBe('Working on it');
    expect(friendlyStageLabel('')).toBe('Working on it');
  });

  it('handles all-caps fragments by title-casing the first letter only', () => {
    // "API_call" → "API Call" (first letter of each word is upper-cased; rest preserved)
    expect(friendlyStageLabel('API_call')).toBe('API Call');
  });
});

describe('STAGE_TIMELINE', () => {
  it('renders the canonical six-step skeleton in orchestrator order', () => {
    expect(STAGE_TIMELINE.map((s) => s.key)).toEqual([
      'creating_project',
      'finding_node',
      'provisioning_node',
      'creating_workspace',
      'starting_agent',
      'agent_booting',
    ]);
  });

  it('every timeline entry has a non-empty label', () => {
    for (const entry of STAGE_TIMELINE) {
      expect(entry.label.length).toBeGreaterThan(0);
    }
  });

  it('timeline labels match STAGE_LABELS for the same key', () => {
    for (const entry of STAGE_TIMELINE) {
      expect(entry.label).toBe(STAGE_LABELS[entry.key]);
    }
  });
});
