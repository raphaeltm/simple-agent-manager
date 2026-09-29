/**
 * PROTOTYPE ONLY — dev-only route `/prototype/resource-timeline`.
 *
 * Renders the real Resources drawer against synthetic sessions. Everything under
 * `components/chat/resource-timeline/` is the production candidate; only this
 * page and its mock data are throwaway. Scenario, backend contract and network
 * latency are URL parameters so a link reproduces exactly what was seen.
 */

import { Button } from '@simple-agent-manager/ui';
import { Activity } from 'lucide-react';
import { useMemo } from 'react';
import { useSearchParams } from 'react-router';

import { SessionResourceHistoryDrawer } from '../../components/chat/SessionResourceHistoryDrawer';
import { scenarioById, SCENARIOS } from './mock-sessions';
import { type BackendMode, createMockSource, type LatencyProfile } from './mock-source';

const BACKENDS: Array<{ id: BackendMode; label: string; detail: string }> = [
  {
    id: 'proposed',
    label: 'Proposed backend',
    detail: 'Every chunk listed, with per-minute rollups stored at upload time.',
  },
  {
    id: 'current',
    label: 'Current backend',
    detail: 'One summary per chunk, and only the newest 24 chunks.',
  },
];

const LATENCIES: Array<{ id: LatencyProfile; label: string }> = [
  { id: 'fast', label: 'Fast network' },
  { id: 'realistic', label: 'Realistic' },
  { id: 'slow', label: 'Slow 3G' },
];

function pick<T extends string>(value: string | null, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

const selectClass =
  'w-full rounded-md border border-border-default bg-surface px-2 py-2 text-sm text-fg-primary';

export function ResourceTimelinePrototype() {
  const [params, setParams] = useSearchParams();
  const scenario = scenarioById(params.get('scenario'));
  const backend = pick(params.get('backend'), ['proposed', 'current'] as const, 'proposed');
  const latency = pick(params.get('latency'), ['fast', 'realistic', 'slow'] as const, 'realistic');
  const open = params.get('open') !== '0';
  const source = useMemo(() => createMockSource(scenario.id, backend, latency), [scenario.id, backend, latency]);

  const update = (key: string, value: string) =>
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        next.set(key, value);
        return next;
      },
      { replace: true }
    );

  return (
    <div style={{ height: '100vh', overflow: 'auto' }} className="bg-canvas text-fg-primary">
      <main className="mx-auto w-full min-w-0 max-w-xl space-y-4 p-4">
        <header>
          <p className="text-xs uppercase tracking-wide text-fg-muted">Prototype</p>
          <h1 className="text-xl font-semibold">Session resources timeline</h1>
          <p className="mt-1 text-sm text-fg-muted">
            The real Resources drawer, fed by synthetic sessions shaped like production ones. Scrub with a finger,
            pinch to zoom, drag the strip under the charts, or tap a busiest moment.
          </p>
        </header>

        <label className="block space-y-1 text-sm">
          <span className="text-fg-muted">Session</span>
          <select className={selectClass} value={scenario.id} onChange={(event) => update('scenario', event.target.value)}>
            {SCENARIOS.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.label}
              </option>
            ))}
          </select>
          <span className="block text-xs text-fg-muted">{scenario.description}</span>
        </label>

        <fieldset className="space-y-1 text-sm">
          <legend className="text-fg-muted">Backend contract</legend>
          {BACKENDS.map((option) => (
            <label key={option.id} className="flex items-start gap-2 rounded-md border border-border-default p-2">
              <input
                type="radio"
                name="backend"
                className="mt-1"
                checked={backend === option.id}
                onChange={() => update('backend', option.id)}
              />
              <span>
                <span className="block">{option.label}</span>
                <span className="block text-xs text-fg-muted">{option.detail}</span>
              </span>
            </label>
          ))}
        </fieldset>

        <label className="block space-y-1 text-sm">
          <span className="text-fg-muted">Network</span>
          <select className={selectClass} value={latency} onChange={(event) => update('latency', event.target.value)}>
            {LATENCIES.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        <Button onClick={() => update('open', '1')}>
          <Activity size={16} aria-hidden="true" />
          Open Resources
        </Button>
      </main>

      {open && (
        <SessionResourceHistoryDrawer
          key={source.cacheKey.join(':')}
          source={source}
          onClose={() => update('open', '0')}
        />
      )}
    </div>
  );
}
