import { describe, expect, it } from 'vitest';

import {
  isFullBleedRoute,
  isProjectChatRoute,
  isProjectOverviewRoute,
} from '../../../src/lib/shell-routes';

describe('isProjectChatRoute', () => {
  it('matches the project chat', () => {
    for (const path of ['/projects/p1/chat', '/projects/p1/chat/', '/projects/p1/chat/s1']) {
      expect(isProjectChatRoute(path)).toBe(true);
    }
  });

  it('does not match the project index, which now lands on the Overview (slice F2)', () => {
    expect(isProjectChatRoute('/projects/p1')).toBe(false);
    expect(isProjectChatRoute('/projects/p1/')).toBe(false);
  });

  it('does not match the other full-bleed routes, which have no chats pane to reserve', () => {
    for (const path of [
      '/projects/p1/agent',
      '/projects/p1/comments/message/c1',
      '/projects/p1/overview',
    ]) {
      expect(isFullBleedRoute(path)).toBe(true);
      expect(isProjectChatRoute(path)).toBe(false);
    }
  });

  it('does not match other project pages', () => {
    for (const path of [
      '/projects/p1/settings',
      '/projects/p1/chats-export',
      '/projects/p1/ideas',
    ]) {
      expect(isProjectChatRoute(path)).toBe(false);
    }
  });
});

describe('isProjectOverviewRoute', () => {
  it('matches the Overview and the project index that redirects to it', () => {
    for (const path of [
      '/projects/p1',
      '/projects/p1/',
      '/projects/p1/overview',
      '/projects/p1/overview/',
    ]) {
      expect(isProjectOverviewRoute(path)).toBe(true);
    }
  });

  it('does not match other project pages or the project list routes', () => {
    for (const path of [
      '/projects',
      '/projects/new',
      '/projects/invite/tok',
      '/projects/invite',
      '/projects/p1/overviews',
      '/projects/p1/chat',
      '/projects/p1/inbox',
    ]) {
      expect(isProjectOverviewRoute(path)).toBe(false);
    }
  });
});

describe('isFullBleedRoute', () => {
  it('lays out the project Overview over the void, but not a path that only starts with it', () => {
    expect(isFullBleedRoute('/projects/p1/overview')).toBe(true);
    expect(isFullBleedRoute('/projects/p1/overviews')).toBe(false);
    expect(isFullBleedRoute('/projects/p1/ideas')).toBe(false);
  });

  it('lays out the project index full-bleed, so its redirect never flashes a padded page', () => {
    expect(isFullBleedRoute('/projects/p1')).toBe(true);
    expect(isFullBleedRoute('/projects/new')).toBe(false);
    expect(isFullBleedRoute('/projects')).toBe(false);
  });
});
