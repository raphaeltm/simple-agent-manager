// PROTOTYPE — design exploration only. Never ships to production.
// Route: /prototype/node-resources?concept=strip|rails|tiles|ledger|glyph|all&theme=dark|light
import { Button, PageLayout } from '@simple-agent-manager/ui';
import { useEffect } from 'react';
import { useSearchParams } from 'react-router';

import { NODE_FIXTURES } from './mock-data';
import { type Concept, ProtoNodeCard } from './ProtoNodeCard';

interface ConceptMeta {
  id: Concept;
  title: string;
  blurb: string;
}

export const CONCEPTS: ConceptMeta[] = [
  {
    id: 'strip',
    title: 'A · Allocation strip',
    blurb:
      'Three horizontal meters (vCPU, RAM, disk). Each workspace is a colored segment matching the dot on its row below; the gap at the end is what is left. The thin white tick is live usage.',
  },
  {
    id: 'rails',
    title: 'B · Edge rails',
    blurb:
      'The card frame is the meter: a vertical CPU rail on the left edge, RAM on the right edge, disk along the bottom. Fill color follows severity; the body of the card is unchanged.',
  },
  {
    id: 'tiles',
    title: 'C · Stat tile trio',
    blurb:
      'Three small tiles lead with the number that matters: how much is free. A 4px stacked bar under each tile shows who has the rest.',
  },
  {
    id: 'ledger',
    title: 'D · Per-workspace ledger',
    blurb:
      'A tiny table: one row per workspace, each cell a bar of that workspace’s share of the node, closing with a Free row. Answers “what does each task take?” directly.',
  },
  {
    id: 'glyph',
    title: 'E · Header glyph',
    blurb:
      'Three 4px bars beside the node name summarize fill at a glance; tapping expands concept A inside the card. Most compact on mobile (second card shown expanded).',
  },
];

const THEME_ATTRIBUTE: Record<'dark' | 'light', string> = { dark: 'sam', light: 'sam-light' };

function isConcept(value: string | null): value is Concept {
  return CONCEPTS.some((concept) => concept.id === value);
}

export function NodeResourcesPrototype() {
  const [params, setParams] = useSearchParams();
  const requested = params.get('concept');
  const selected: Concept | 'all' = requested === 'all' ? 'all' : isConcept(requested) ? requested : 'strip';
  const theme = params.get('theme') === 'light' ? 'light' : 'dark';

  // ThemeProvider's mount effect runs after this child effect and would win; defer one tick.
  useEffect(() => {
    const id = window.setTimeout(() => {
      document.documentElement.setAttribute('data-ui-theme', THEME_ATTRIBUTE[theme]);
    }, 0);
    return () => window.clearTimeout(id);
  }, [theme]);

  const visible = selected === 'all' ? CONCEPTS : CONCEPTS.filter((concept) => concept.id === selected);
  const compare = params.get('layout') === 'compare';

  const select = (concept: Concept | 'all') => {
    const next = new URLSearchParams(params);
    next.set('concept', concept);
    setParams(next, { replace: true });
  };

  if (compare) {
    // Screenshot-only layout: a 375px mobile column beside a two-column desktop grid, so one
    // image shows how a concept reads at both widths. Cards are fluid, so a 375px column renders
    // exactly as the mobile single-column page does.
    const concept = visible[0] ?? CONCEPTS[0];
    if (!concept) return null;
    const pick = (ids: string[]) => ids.flatMap((id) => NODE_FIXTURES.filter((f) => f.node.id === id));
    const mobile = pick(['n1', 'n6']);
    const desktop = pick(['n1', 'n2', 'n4', 'n3']);
    return (
      <div style={{ height: '100vh', overflow: 'auto', background: 'var(--sam-color-bg-canvas)' }}>
        <div id="compare" style={{ width: 1200, padding: 24, display: 'flex', flexDirection: 'column', gap: 16, background: 'var(--sam-color-bg-canvas)' }}>
          <div>
            <h2 className="sam-type-card-title text-fg-primary m-0 mb-1">{concept.title}</h2>
            <p className="sam-type-secondary text-fg-muted m-0" style={{ maxWidth: 900 }}>{concept.blurb}</p>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '375px minmax(0,1fr)', gap: 32, alignItems: 'start' }}>
            <div className="flex flex-col gap-3">
              <span className="sam-type-caption text-fg-muted">Mobile · 375px</span>
              <div className="flex flex-col gap-4">
                {mobile.map((fixture, index) => (
                  <ProtoNodeCard key={fixture.node.id} concept={concept.id} node={fixture.node} workspaces={fixture.workspaces} initiallyExpanded={concept.id === 'glyph' && index === 0} />
                ))}
              </div>
            </div>
            <div className="flex flex-col gap-3 min-w-0">
              <span className="sam-type-caption text-fg-muted">Desktop · two-column grid</span>
              <div className="grid grid-cols-2 gap-4 items-start">
                {desktop.map((fixture, index) => (
                  <ProtoNodeCard key={fixture.node.id} concept={concept.id} node={fixture.node} workspaces={fixture.workspaces} initiallyExpanded={concept.id === 'glyph' && index === 1} />
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ height: '100vh', overflow: 'auto' }}>
      <PageLayout title="Nodes" maxWidth="xl">
        <div className="flex justify-between items-center mb-6 gap-3 flex-wrap">
          <p className="sam-type-secondary m-0 text-fg-muted">Nodes host workspaces or project deployment environments.</p>
          <Button variant="primary">Create Node</Button>
        </div>

        <div className="flex flex-wrap gap-2 mb-2" role="tablist" aria-label="Visualization concept">
          {[...CONCEPTS.map((c) => ({ id: c.id as Concept | 'all', label: c.title.slice(0, 1) })), { id: 'all' as const, label: 'All' }].map((tab) => (
            <Button
              key={tab.id}
              role="tab"
              aria-selected={selected === tab.id}
              size="sm"
              variant={selected === tab.id ? 'primary' : 'secondary'}
              onClick={() => select(tab.id)}
            >
              {tab.label}
            </Button>
          ))}
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              const next = new URLSearchParams(params);
              next.set('theme', theme === 'dark' ? 'light' : 'dark');
              setParams(next, { replace: true });
            }}
          >
            {theme === 'dark' ? 'Light theme' : 'Dark theme'}
          </Button>
        </div>

        {visible.map((concept) => (
          <section key={concept.id} className="mb-8" aria-label={concept.title}>
            <h2 className="sam-type-card-title text-fg-primary m-0 mb-1">{concept.title}</h2>
            <p className="sam-type-secondary text-fg-muted m-0 mb-4" style={{ maxWidth: 720 }}>
              {concept.blurb}
            </p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 items-start">
              {NODE_FIXTURES.map((fixture, index) => (
                <ProtoNodeCard
                  key={`${concept.id}-${fixture.node.id}`}
                  concept={concept.id}
                  node={fixture.node}
                  workspaces={fixture.workspaces}
                  initiallyExpanded={concept.id === 'glyph' && index === 1}
                />
              ))}
            </div>
          </section>
        ))}
      </PageLayout>
    </div>
  );
}
