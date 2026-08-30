/**
 * Floating scenario switcher for hands-on exploration of the prototype.
 *
 * `position: fixed` so it overlays without perturbing the layout under test, and it
 * is suppressed entirely with `?chrome=0` for screenshot runs.
 */
import { X } from 'lucide-react';
import { useState } from 'react';

/** Matches the setter returned by `useSearchParams()`. */
type SetParams = (next: URLSearchParams, opts?: { replace?: boolean }) => void;

/** `fallback` mirrors the default each param resolves to in `index.tsx`. */
const GROUPS: Array<{
  key: string;
  label: string;
  fallback: string;
  options: Array<[string, string]>;
}> = [
  {
    key: 'variant',
    label: 'Variation',
    fallback: 'rail',
    options: [
      ['none', 'Today'],
      ['rail', 'A · Right rail'],
      ['dock', 'B · Bottom dock'],
    ],
  },
  {
    key: 'mode',
    label: 'Strip',
    fallback: 'icons',
    options: [
      ['icons', 'Icons'],
      ['labels', 'Labels'],
      ['hidden', 'Hidden'],
    ],
  },
  {
    key: 'state',
    label: 'Session',
    fallback: 'sleeping',
    options: [
      ['active', 'Active'],
      ['idle', 'Idle'],
      ['sleeping', 'Sleeping'],
      ['terminated', 'Stopped'],
    ],
  },
];

// No "details open" toggle: `SessionHeader` owns its disclosure state internally and
// exposes no prop for it. Opening it means clicking the real chevron, which is also
// what the Playwright audit does (`.claude/rules/62-tests-must-observe-the-real-trigger.md`).
const TOGGLES: Array<[string, string]> = [
  ['long', 'Long text'],
  ['empty', 'Empty'],
];

export function ScenarioSwitcher({
  params,
  setParams,
  lastAction,
  onClearAction,
}: {
  params: URLSearchParams;
  setParams: SetParams;
  lastAction: string | null;
  onClearAction: () => void;
}) {
  const [open, setOpen] = useState(false);

  function set(key: string, value: string) {
    const next = new URLSearchParams(params);
    next.set(key, value);
    setParams(next, { replace: true });
  }

  function toggle(key: string) {
    const next = new URLSearchParams(params);
    if (next.has(key)) next.delete(key);
    else next.set(key, '1');
    setParams(next, { replace: true });
  }

  const current = (key: string, fallback: string) => params.get(key) ?? fallback;

  return (
    <>
      {lastAction && (
        <div
          role="status"
          data-testid="tool-activation-readout"
          className="fixed bottom-24 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium shadow-lg"
          style={{
            backgroundColor: 'var(--sam-color-bg-surface)',
            border: '1px solid var(--sam-color-border-default)',
            color: 'var(--sam-color-fg-primary)',
          }}
        >
          <span>
            Tool activated: <strong>{lastAction}</strong>
          </span>
          <button
            type="button"
            onClick={onClearAction}
            aria-label="Dismiss"
            className="bg-transparent border-none cursor-pointer text-fg-muted p-0 flex"
          >
            <X size={12} />
          </button>
        </div>
      )}

      {!open && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="fixed bottom-3 left-3 z-50 px-2.5 py-1 rounded-full text-[10px] font-semibold uppercase tracking-wider cursor-pointer shadow-lg"
          style={{
            backgroundColor: 'var(--sam-color-bg-surface)',
            border: '1px solid var(--sam-color-border-default)',
            color: 'var(--sam-color-fg-muted)',
          }}
        >
          Scenarios
        </button>
      )}

      {open && (
        <div
          className="fixed bottom-3 left-3 z-50 w-[228px] max-h-[70vh] overflow-y-auto rounded-lg p-3 space-y-2.5 shadow-2xl"
          style={{
            backgroundColor: 'var(--sam-color-bg-surface)',
            border: '1px solid var(--sam-color-border-default)',
          }}
        >
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-fg-muted">
              Scenarios
            </span>
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Close scenario switcher"
              className="bg-transparent border-none cursor-pointer text-fg-muted p-0 flex"
            >
              <X size={13} />
            </button>
          </div>

          {GROUPS.map((group) => (
            <div key={group.key} className="space-y-1">
              <div className="text-[10px] font-medium text-fg-muted">{group.label}</div>
              <div className="flex flex-wrap gap-1">
                {group.options.map(([value, label]) => {
                  const active = current(group.key, group.fallback) === value;
                  return (
                    <button
                      key={value}
                      type="button"
                      onClick={() => set(group.key, value)}
                      className="text-[10px] font-medium px-1.5 py-1 rounded cursor-pointer border"
                      style={{
                        borderColor: active
                          ? 'var(--sam-color-accent-primary)'
                          : 'var(--sam-color-border-default)',
                        backgroundColor: active ? 'var(--sam-color-accent-tint)' : 'transparent',
                        color: active
                          ? 'var(--sam-color-accent-primary)'
                          : 'var(--sam-color-fg-muted)',
                      }}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}

          <div className="flex flex-wrap gap-1 pt-1">
            {TOGGLES.map(([key, label]) => {
              const active = params.has(key);
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => toggle(key)}
                  className="text-[10px] font-medium px-1.5 py-1 rounded cursor-pointer border"
                  style={{
                    borderColor: active
                      ? 'var(--sam-color-accent-primary)'
                      : 'var(--sam-color-border-default)',
                    backgroundColor: active ? 'var(--sam-color-accent-tint)' : 'transparent',
                    color: active ? 'var(--sam-color-accent-primary)' : 'var(--sam-color-fg-muted)',
                  }}
                >
                  {label}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </>
  );
}
