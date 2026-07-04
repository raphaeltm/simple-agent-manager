// PROTOTYPE ONLY — unauthed design-exploration page for the task hierarchy modal.
// Must NOT ship to production. See .claude/rules/37-prototype-development.md.
import { useState } from 'react';

import { HierarchyModal } from '../../components/task-hierarchy/HierarchyModal';
import { SCENARIOS } from './mock-data';

export function TaskHierarchyPrototype() {
  const [scenarioId, setScenarioId] = useState(SCENARIOS[0]!.id);
  const [isOpen, setIsOpen] = useState(true);
  const [lastNavigation, setLastNavigation] = useState<string | null>(null);

  const scenario = SCENARIOS.find((s) => s.id === scenarioId) ?? SCENARIOS[0]!;

  return (
    // App shell disables document scrolling — prototype needs its own scroll container.
    <div
      style={{
        height: '100vh',
        overflow: 'auto',
        background: 'var(--sam-color-bg-base)',
        color: 'var(--sam-color-fg-primary)',
      }}
    >
      <div className="max-w-2xl mx-auto px-4 py-6 flex flex-col gap-4">
        <div>
          <h1 className="text-lg font-semibold">Task Hierarchy Prototype</h1>
          <p className="text-xs" style={{ color: 'var(--sam-color-fg-muted)' }}>
            Real <code>HierarchyModal</code> component with stress-test mock data. Prototype route
            — not shipped to production.
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          {SCENARIOS.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => {
                setScenarioId(s.id);
                setIsOpen(true);
                setLastNavigation(null);
              }}
              className="rounded-md text-xs font-medium px-3 py-1.5"
              style={{
                border:
                  s.id === scenario.id
                    ? '1px solid var(--sam-color-accent-primary)'
                    : '1px solid var(--sam-color-border-default)',
                background:
                  s.id === scenario.id
                    ? 'var(--sam-color-accent-primary-tint)'
                    : 'var(--sam-color-bg-inset)',
                color: 'var(--sam-color-fg-primary)',
                cursor: 'pointer',
              }}
            >
              {s.label}
            </button>
          ))}
        </div>

        <p className="text-xs" style={{ color: 'var(--sam-color-fg-muted)' }}>
          {scenario.description}
        </p>

        {!isOpen && (
          <button
            type="button"
            onClick={() => setIsOpen(true)}
            className="rounded-md text-sm font-medium px-4 py-2 self-start"
            style={{
              border: '1px solid var(--sam-color-accent-primary)',
              background: 'var(--sam-color-accent-primary-tint)',
              color: 'var(--sam-color-fg-primary)',
              cursor: 'pointer',
            }}
          >
            Reopen hierarchy modal
          </button>
        )}

        {lastNavigation && (
          <p className="text-xs" style={{ color: 'var(--sam-color-fg-muted)' }}>
            Last navigation: <code>{lastNavigation}</code>
          </p>
        )}

        <HierarchyModal
          key={scenario.id}
          isOpen={isOpen}
          onClose={() => setIsOpen(false)}
          focusTaskId={scenario.focusTaskId}
          taskInfoMap={scenario.taskInfoMap}
          sessions={scenario.sessions}
          onNavigate={(sessionId) => setLastNavigation(sessionId)}
        />
      </div>
    </div>
  );
}
