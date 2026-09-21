import { PageLayout } from '@simple-agent-manager/ui';
import { useMemo, useState } from 'react';

import { NodeCard } from '../../components/node/NodeCard';
import { buildNodeCapacity } from './capacity';
import { ConceptHeadroom } from './ConceptHeadroom';
import { ConceptLedger } from './ConceptLedger';
import { ConceptRails } from './ConceptRails';
import { ConceptReservedVsMeasured } from './ConceptReservedVsMeasured';
import { MOCK_NODES, MOCK_WORKSPACES } from './mock-data';

/**
 * PROTOTYPE — node resource-utilisation concepts.
 *
 * Route: /prototype/node-resources (dev-only, unauthed, no API calls).
 * Renders the REAL `NodeCard` from the real nodes page, with each concept injected
 * through the card's prototype `resourceSlot`, so what you see is what the card
 * would actually look like — including how much vertical space the viz costs.
 *
 * Delete this directory, the `resourceSlot` prop on NodeCard, and the route in
 * App.tsx before any merge to main.
 */

type ConceptId = 'rails' | 'reserved-vs-used' | 'ledger' | 'headroom';

interface Concept {
  id: ConceptId;
  name: string;
  tagline: string;
}

const RAILS_CONCEPT: Concept = {
  id: 'rails',
  name: 'A · Capacity rails',
  tagline: 'Three part-to-whole rails, segmented by workspace. “How full, and who’s in it.”',
};

const CONCEPTS: Concept[] = [
  RAILS_CONCEPT,
  {
    id: 'reserved-vs-used',
    name: 'B · Reserved vs used',
    tagline:
      'Reservation envelope against measured usage and the host’s own reading. “Did we ask for the right size?”',
  },
  {
    id: 'ledger',
    name: 'C · Workspace ledger',
    tagline: 'One row per workspace, three comparable micro-bars. “Who is costing me this node?”',
  },
  {
    id: 'headroom',
    name: 'D · Headroom slots',
    tagline: 'Capacity quantised into workspace-sized slots. “What fits here next?”',
  },
];

function renderConcept(id: ConceptId, capacity: ReturnType<typeof buildNodeCapacity>) {
  switch (id) {
    case 'rails':
      return <ConceptRails capacity={capacity} />;
    case 'reserved-vs-used':
      return <ConceptReservedVsMeasured capacity={capacity} />;
    case 'ledger':
      return <ConceptLedger capacity={capacity} />;
    case 'headroom':
      return <ConceptHeadroom capacity={capacity} />;
  }
}

const noop = () => {};

export function NodeResourcesPrototype() {
  const [concept, setConcept] = useState<ConceptId>('rails');

  const capacities = useMemo(
    () =>
      MOCK_NODES.map((node) =>
        buildNodeCapacity(
          node,
          MOCK_WORKSPACES.filter((ws) => ws.nodeId === node.id)
        )
      ),
    []
  );

  const active = CONCEPTS.find((c) => c.id === concept) ?? RAILS_CONCEPT;

  return (
    // The app deliberately does not scroll at the html/body level (index.css pins
    // html, body and #root to --sam-app-height and hides overflow at >=768px), so a
    // prototype page must bring its own viewport-height scroll container.
    <div
      data-prototype="node-resources"
      style={{ height: 'var(--sam-app-height, 100vh)', overflow: 'auto' }}
      className="bg-canvas"
    >
      <PageLayout title="Node resource visualisation concepts" maxWidth="xl">
        <header className="flex flex-col gap-2 mb-4 min-w-0">
          <h2 className="sam-type-page-title text-fg-primary m-0">Node resource concepts</h2>
          <p className="sam-type-secondary text-fg-muted m-0 [overflow-wrap:anywhere]">
            Prototype only. The card, badges, hardware block and workspace list below are the
            real components from <code>/nodes</code>; only the resource block changes per concept.
          </p>
        </header>

        <nav
          aria-label="Concept"
          className="flex flex-wrap gap-2 mb-3 min-w-0"
          data-testid="concept-switcher"
        >
          {CONCEPTS.map((item) => {
            const selected = item.id === concept;
            return (
              <button
                key={item.id}
                type="button"
                aria-pressed={selected}
                onClick={() => setConcept(item.id)}
                className={`sam-type-caption rounded-full px-3 py-1.5 border transition-colors ${
                  selected
                    ? 'bg-accent-tint border-accent text-accent font-medium'
                    : 'bg-inset border-border-default text-fg-muted hover:bg-surface-hover'
                }`}
              >
                {item.name}
              </button>
            );
          })}
        </nav>

        <p
          className="sam-type-secondary text-fg-muted m-0 mb-5 [overflow-wrap:anywhere]"
          data-testid="concept-tagline"
        >
          {active.tagline}
        </p>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 items-start">
          {capacities.map((capacity) => (
            <NodeCard
              key={capacity.node.id}
              node={capacity.node}
              workspaces={capacity.tenants.map((t) => t.workspace)}
              onStop={noop}
              onDelete={noop}
              onCreateWorkspace={noop}
              resourceSlot={renderConcept(concept, capacity)}
            />
          ))}
        </div>

        <p className="sam-type-caption text-fg-muted mt-6 mb-0 [overflow-wrap:anywhere]">
          Fixtures reproduce the 2026-09-20 production shape (one cx53 with five workspaces, one
          cx43 with one) plus a near-saturated host, an empty warm node, an exclusive tenant, and a
          node that has not reported hardware yet. Capacity math mirrors the scheduler:
          CPU budget = vCPU × 1000, usable RAM = RAM − 512 MB host reserve, disk = GB × 1024.
        </p>
      </PageLayout>
    </div>
  );
}

export default NodeResourcesPrototype;
