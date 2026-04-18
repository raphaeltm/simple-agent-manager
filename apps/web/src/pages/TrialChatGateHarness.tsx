/**
 * Test-harness page for the trial ChatGate + LoginSheet components.
 *
 * Wave-1 Track D ships the components but not the integration (that lands in
 * Wave-2 when SSE streams `trial.idea` events into `TryDiscovery`). To keep
 * rule 17 (Playwright visual audits) honored, this harness mounts the
 * components with mock data driven by query params so Playwright can capture
 * screenshots at 375×667 and 1280×800.
 *
 * Query params:
 *   - `ideas`     — integer 0..20, number of suggestion chips to render
 *   - `long`      — any truthy value; uses long titles/summaries to exercise
 *                   truncation and wrapping
 *   - `auth`      — `1` pretends the visitor is authenticated; default anonymous
 *   - `loginOpen` — any truthy value; renders the login sheet open
 *
 * NOT linked from navigation anywhere — the only entrypoint is the Playwright
 * audit suite. Rendered under `/__test/trial-chat-gate`.
 */
import type { TrialIdea } from '@simple-agent-manager/shared';
import { useMemo } from 'react';
import { useSearchParams } from 'react-router';

import { ChatGate } from '../components/trial/ChatGate';
import { LoginSheet } from '../components/trial/LoginSheet';

const LONG_TITLE =
  'Explain how this repository handles authentication, session management, and credential rotation end-to-end';
const LONG_SUMMARY =
  'Walk through every layer — from the API worker and its middleware, into the Durable Objects, out to the VM agent, and back to the browser for real-time updates. Include the failure modes and retry semantics.';

function makeIdea(i: number, long: boolean): TrialIdea {
  return {
    id: `idea-${i}`,
    title: long ? `${LONG_TITLE} (#${i + 1})` : `Idea ${i + 1}`,
    summary: long ? LONG_SUMMARY : `Short idea summary for chip ${i + 1}`,
    prompt: long ? LONG_TITLE : `Prompt for idea ${i + 1}`,
  };
}

export function TrialChatGateHarness() {
  const [params] = useSearchParams();
  const count = Math.min(Math.max(Number(params.get('ideas') ?? '5'), 0), 20);
  const long = params.get('long') != null;
  const auth = params.get('auth') === '1';
  const loginOpen = params.get('loginOpen') != null;

  const ideas = useMemo<TrialIdea[]>(
    () => Array.from({ length: count }, (_, i) => makeIdea(i, long)),
    [count, long],
  );

  return (
    <div className="min-h-screen bg-canvas text-fg-primary">
      <div className="mx-auto max-w-3xl px-4 py-8 md:py-12">
        <h1 className="sr-only">Trial ChatGate harness</h1>
        <div data-testid="harness-scenario" className="sr-only">
          {`ideas=${count} long=${long} auth=${auth} loginOpen=${loginOpen}`}
        </div>
        <ChatGate
          trialId="trial-harness"
          ideas={ideas}
          forceAnonymous={!auth}
          onAuthenticatedSubmit={async () => {
            // No-op in harness — Playwright doesn't exercise the send path.
          }}
        />
        {loginOpen && (
          <LoginSheet
            isOpen
            onClose={() => {}}
            trialId="trial-harness"
            onSignIn={async () => {
              // No-op — Playwright doesn't redirect to GitHub.
            }}
          />
        )}
      </div>
    </div>
  );
}
