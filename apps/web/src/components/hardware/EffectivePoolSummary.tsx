import type { SafeEffectiveCapacityPoolSummary } from '@simple-agent-manager/shared';
import { useEffect, useState } from 'react';

import {
  fetchProjectDefaultCapacityPools,
  fetchUserDefaultCapacityPools,
} from '../../lib/api/capacity-pools';

const STATES: Record<SafeEffectiveCapacityPoolSummary['state'], string> = {
  unconfigured: 'Not configured',
  'configured-ready': 'Available',
  'configured-empty': 'Empty — no eligible offerings',
  'source-disabled': 'Unavailable — compute source disabled',
  'catalog-unavailable': 'Unavailable — catalog refresh needed',
  'migration-pending': 'Migration in progress',
};

/** Consumes the canonical safe summary, including installation capacity for ordinary users. */
export function EffectivePoolSummary({ projectId }: { projectId?: string | null }) {
  const [result, setResult] = useState<{
    projectId: string | null;
    summary?: SafeEffectiveCapacityPoolSummary;
    error?: boolean;
  }>();
  const key = projectId ?? null;
  useEffect(() => {
    let active = true;
    const request = key ? fetchProjectDefaultCapacityPools(key) : fetchUserDefaultCapacityPools();
    void request
      .then((response) => {
        if (active) setResult({ projectId: key, summary: response.effectiveSummary });
      })
      .catch(() => {
        if (active) setResult({ projectId: key, error: true });
      });
    return () => {
      active = false;
    };
  }, [key]);
  const current = result?.projectId === key ? result : undefined;
  const summary = current?.summary;
  return (
    <div
      className="grid gap-1 text-xs min-w-0 [overflow-wrap:anywhere]"
      aria-label="Effective compute pool"
    >
      <span className="text-fg-muted">Current compute pool</span>
      <span className="text-fg-primary">
        {!current
          ? 'Loading compute pool…'
          : !summary
            ? 'Compute pool details unavailable'
            : `${summary.scope === 'installation' ? 'Installation-funded' : summary.scope === 'project' ? 'Project' : summary.scope === 'user' ? 'Personal' : 'No'} pool · ${STATES[summary.state]}`}
      </span>
      {summary?.strategy && (
        <span className="text-fg-muted">
          Strategy: {summary.strategy} · {summary.availableCandidateCount} available offerings
        </span>
      )}
      {summary?.exhaustionPolicy && (
        <span className="text-fg-muted">
          When full:{' '}
          {summary.exhaustionPolicy === 'queue'
            ? 'wait for capacity'
            : summary.exhaustionPolicy === 'fail'
              ? 'stop with a capacity error'
              : 'try selected alternatives in this pool'}
        </span>
      )}
    </div>
  );
}
