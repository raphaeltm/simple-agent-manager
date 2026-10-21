import { describe, expect, it } from 'vitest';

import {
  automationPaths,
  legacyEventsTarget,
  legacyTriggersTarget,
  parseHistoryItem,
} from '../../../src/lib/automation-routes';

const events = (query: string) => legacyEventsTarget('p1', new URLSearchParams(query));
const triggers = (query: string) => legacyTriggersTarget('p1', new URLSearchParams(query));

describe('automation paths', () => {
  it('builds every view', () => {
    expect(automationPaths.overview('p1')).toBe('/projects/p1/automation');
    expect(automationPaths.overview('p1', 'once')).toBe('/projects/p1/automation?filter=once');
    expect(automationPaths.create('p1', { sessionId: 'chat 1' })).toBe(
      '/projects/p1/automation/new?sessionId=chat+1'
    );
    expect(automationPaths.create('p1', { template: 'pr-summary' })).toBe(
      '/projects/p1/automation/new?template=pr-summary'
    );
    expect(automationPaths.detail('p1', 'watch', 'w/1')).toBe(
      '/projects/p1/automation/watch/w%2F1'
    );
    expect(automationPaths.edit('p1', 'trigger', 't1')).toBe(
      '/projects/p1/automation/trigger/t1/edit'
    );
    expect(automationPaths.history('p1', { kind: 'schedule', id: 's1' })).toBe(
      '/projects/p1/automation/history?item=schedule%3As1'
    );
    expect(automationPaths.behind('p1', { tab: 'channels' })).toBe(
      '/projects/p1/automation/behind?tab=channels'
    );
  });

  it('parses History item filters and rejects malformed ones', () => {
    expect(parseHistoryItem('trigger:t1')).toEqual({ kind: 'trigger', id: 't1' });
    expect(parseHistoryItem('nope:t1')).toBeNull();
    expect(parseHistoryItem(':t1')).toBeNull();
    expect(parseHistoryItem(null)).toBeNull();
  });
});

describe('old Events URLs', () => {
  it('send each section to the view that replaced it', () => {
    expect(events('')).toBe('/projects/p1/automation');
    expect(events('section=subscriptions')).toBe('/projects/p1/automation/behind');
    expect(events('section=channels')).toBe('/projects/p1/automation/behind?tab=channels');
    expect(events('section=schedules')).toBe('/projects/p1/automation?filter=once');
    expect(events('section=watches')).toBe('/projects/p1/automation?filter=reacting');
  });

  it('keep a chat scope from the old chat drawer link, whatever section it named', () => {
    expect(events('sessionId=chat-9')).toBe('/projects/p1/automation/behind?sessionId=chat-9');
    expect(events('section=schedules&sessionId=chat-9')).toBe(
      '/projects/p1/automation/behind?sessionId=chat-9'
    );
    expect(events('section=channels&sessionId=chat-9')).toBe(
      '/projects/p1/automation/behind?tab=channels'
    );
  });
});

describe('old Triggers URLs', () => {
  it('open the list, the create flow or a trigger editor', () => {
    expect(triggers('')).toBe('/projects/p1/automation');
    expect(triggers('edit=new')).toBe('/projects/p1/automation/new');
    expect(triggers('edit=t1')).toBe('/projects/p1/automation/trigger/t1/edit');
  });
});
