/**
 * PROTOTYPE — dev-only route `/prototype/automation` (see App.tsx DEV_ONLY_ROUTE_PATHS).
 * Never ships: remove this directory and its route before any merge to main
 * (.claude/rules/37-prototype-development.md).
 *
 * A single "Automation" page that replaces today's separate Events and Triggers pages.
 * Audit that motivated it: SAM idea 01M5CYV085D3N1Z5PZD8C5JN2D.
 *
 * Design rules this prototype tests:
 * - One mental model: every automation is "when X → do Y". Recurring triggers, one-off
 *   schedules and standing watches are the same object, grouped by what starts them.
 * - Problems first: "Needs your attention" says what happened and offers the fix
 *   (auto-paused after failures, run limit used up, delivery not confirmed).
 * - Plain words by default, full power on request: cron, filters, limits and IDs live
 *   under "Advanced"; agent-created subscriptions and channels live under
 *   "Behind the scenes"; SAM's own relays (agent-dm.*) are hidden behind a switch.
 * - Status pills only for exceptions; normal running items stay quiet.
 * - Every control is ≥44 px and spaced with gap-*, never space-y-* on m-0 children.
 *
 * Every view is URL-driven so it can be deep-linked and screenshotted:
 *   ?view=overview (default) | detail&id=<id>[&adv=1] | new&step=when|schedule|do|review
 *   | history[&id=<id>] | behind&tab=waiting|channels[&channel=<name>][&system=1] | empty | chat
 */
import { useEffect, useMemo } from 'react';
import { useSearchParams } from 'react-router';

import { BehindTheScenes } from './behind-the-scenes';
import { ChatAutomationPanel, ChatBackdrop } from './chat-panel';
import { Detail } from './detail';
import { EmptyAutomation } from './empty';
import { AppFrame } from './frame';
import { History } from './history';
import { byId } from './mock-data';
import type { BehindTab, Nav, NewStep, View } from './nav';
import { NewAutomation } from './new-automation';
import { Overview } from './overview';

export function AutomationPrototype() {
  const [params, setParams] = useSearchParams();
  const view = (params.get('view') as View | null) ?? 'overview';
  const key = params.toString();

  const nav = useMemo<Nav>(() => {
    const go = (next: Record<string, string>) => setParams(next);
    return {
      overview: () => go({}),
      detail: (id) => go({ view: 'detail', id }),
      create: (step: NewStep) => go({ view: 'new', step }),
      history: (id?: string) => go(id ? { view: 'history', id } : { view: 'history' }),
      behind: (tab: BehindTab) => go({ view: 'behind', tab }),
    };
  }, [setParams]);

  // Every view change starts at the top, like a page navigation would.
  useEffect(() => {
    document.getElementById('proto-scroll')?.scrollTo({ top: 0 });
  }, [key]);

  let content;
  switch (view) {
    case 'detail': {
      const a = byId(params.get('id'));
      content = a ? (
        <Detail a={a} nav={nav} advancedOpen={params.get('adv') === '1'} />
      ) : (
        <Overview nav={nav} />
      );
      break;
    }
    case 'new':
      content = <NewAutomation step={(params.get('step') as NewStep | null) ?? 'when'} nav={nav} />;
      break;
    case 'history':
      content = <History nav={nav} automationId={params.get('id') ?? undefined} />;
      break;
    case 'behind':
      content = (
        <BehindTheScenes
          tab={(params.get('tab') as BehindTab | null) ?? 'waiting'}
          channel={params.get('channel')}
          showSystem={params.get('system') === '1'}
          nav={nav}
        />
      );
      break;
    case 'empty':
      content = <EmptyAutomation nav={nav} />;
      break;
    case 'chat':
      content = <ChatBackdrop />;
      break;
    default:
      content = <Overview nav={nav} />;
  }

  return (
    <div data-testid="automation-prototype-page">
      <AppFrame key={key} overlay={view === 'chat' ? <ChatAutomationPanel nav={nav} /> : undefined}>
        {content}
      </AppFrame>
    </div>
  );
}
