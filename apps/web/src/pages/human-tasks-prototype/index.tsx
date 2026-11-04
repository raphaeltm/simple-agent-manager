/**
 * PROTOTYPE ONLY — /prototype/human-tasks. Agents assign non-blocking work to humans and wake
 * when a human comments, ticks a step, takes, finishes or archives it. Mock data, no API, no
 * auth. Must be removed before any merge to main (.claude/rules/37-prototype-development.md).
 *
 * `?scene=<name>` jumps to a scripted moment (see SCENES in model.ts); `?clean=1` hides the
 * prototype controls for screenshots.
 */
import { SegmentedControl } from '@simple-agent-manager/ui';
import { useReducer } from 'react';
import { useSearchParams } from 'react-router';

import { useIsMobile } from '../../hooks/useIsMobile';
import { type Mode, reducer, SCENES, sceneState } from './model';
import { DeliveryToast } from './parts';
import { ChatView, HomeView, Sidebar, TasksView } from './views';

export function HumanTasksPrototype() {
  const [params] = useSearchParams();
  const sceneName = params.get('scene');
  const clean = params.get('clean') === '1';
  const [state, dispatch] = useReducer(reducer, sceneName, sceneState);
  const isMobile = useIsMobile();
  const latest = state.deliveries.at(-1);

  const setMode = (mode: Mode) => {
    window.location.search = `?scene=${mode === 'solo' ? 'solo-chat' : 'team-chat'}`;
  };

  const main =
    state.view === 'chat' ? (
      <ChatView state={state} dispatch={dispatch} compact={isMobile} />
    ) : state.view === 'tasks' ? (
      <TasksView state={state} dispatch={dispatch} compact={isMobile} />
    ) : (
      <HomeView state={state} dispatch={dispatch} />
    );

  return (
    <div style={{ height: '100vh', overflow: 'auto' }}>
      <div
        className={`sam-void grid h-screen min-h-0 gap-[var(--sam-space-gutter)] ${isMobile ? 'grid-rows-[auto_minmax(0,1fr)] p-2.5' : 'grid-cols-[248px_minmax(0,1fr)] p-4'}`}
      >
        {isMobile ? (
          <div className="sam-glass sam-glass--slab sam-glass-rim flex items-center gap-2 rounded-[var(--sam-radius-slab)] px-3 py-2">
            <img src="/sam-head.png" alt="SAM" className="h-7 w-7 object-contain" />
            <span className="flex-1 truncate text-sm font-semibold text-fg-primary">
              Acme Billing
            </span>
            <SegmentedControl
              className="w-[156px] shrink-0"
              label="Section"
              value={state.view}
              onChange={(view) => dispatch({ type: 'view', view })}
              options={[
                { value: 'chat', label: 'Chat' },
                {
                  value: 'tasks',
                  label: 'Tasks',
                  count: state.tasks.filter((t) => t.status === 'open').length,
                },
              ]}
            />
          </div>
        ) : (
          <Sidebar state={state} dispatch={dispatch} />
        )}
        <div className="grid min-h-0">{main}</div>
      </div>

      <div
        className={`pointer-events-none fixed inset-x-0 z-40 flex justify-center px-4 ${isMobile ? 'top-[68px]' : 'bottom-28'}`}
      >
        <DeliveryToast delivery={latest} viewer={state.viewer} />
      </div>

      {!clean && (
        <div className="fixed right-4 bottom-4 z-50 flex items-center gap-2 rounded-full bg-black/60 px-3 py-1.5 text-xs text-white">
          <span>Prototype</span>
          <button
            type="button"
            className="cursor-pointer rounded-full border-0 bg-white/15 px-2 py-0.5 text-white"
            onClick={() => setMode('solo')}
          >
            Solo
          </button>
          <button
            type="button"
            className="cursor-pointer rounded-full border-0 bg-white/15 px-2 py-0.5 text-white"
            onClick={() => setMode('team')}
          >
            Team
          </button>
          <select
            aria-label="Jump to scene"
            className="rounded bg-white/15 text-white"
            value={sceneName ?? ''}
            onChange={(e) => {
              window.location.search = `?scene=${e.target.value}`;
            }}
          >
            <option value="">scene…</option>
            {Object.keys(SCENES).map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
      )}
    </div>
  );
}
