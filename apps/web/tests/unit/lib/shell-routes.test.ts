import { describe, expect, it } from 'vitest';

import { isFullBleedRoute, isProjectChatRoute } from '../../../src/lib/shell-routes';

describe('isProjectChatRoute', () => {
  it('matches the project chat and the project index that redirects to it', () => {
    for (const path of [
      '/projects/p1',
      '/projects/p1/',
      '/projects/p1/chat',
      '/projects/p1/chat/s1',
    ]) {
      expect(isProjectChatRoute(path)).toBe(true);
    }
  });

  it('does not match the other full-bleed routes, which have no chats pane to reserve', () => {
    for (const path of ['/projects/p1/agent', '/projects/p1/comments/message/c1']) {
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
