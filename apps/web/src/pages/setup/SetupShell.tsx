import { GlassNodeField } from '@simple-agent-manager/ui';
import { Check } from 'lucide-react';
import type { ReactNode } from 'react';

export interface SetupStepMarker {
  key: string;
  label: string;
}

interface SetupShellProps {
  /** The steps shown in the indicator; omitted on screens outside the step sequence. */
  steps?: SetupStepMarker[];
  currentStep?: string;
  footer?: ReactNode;
  children: ReactNode;
}

/**
 * The first-run setup frame: SAM's node field behind one glass pane, like the sign-in page.
 *
 * The app locks `html`, `body` and `#root` to the viewport on desktop (`index.css`), so this
 * page owns its scrolling: `<main>` is the scroll container, positioned so absolutely placed
 * descendants scroll with it (rule 56). The field sits in a fixed layer behind it.
 */
export function SetupShell({ steps, currentStep, footer, children }: SetupShellProps) {
  const currentIndex = steps?.findIndex((step) => step.key === currentStep) ?? -1;

  return (
    <main
      data-testid="setup-scroll"
      className="relative isolate h-[var(--sam-app-height)] overflow-y-auto overflow-x-hidden bg-canvas text-fg-primary"
    >
      <div className="pointer-events-none fixed inset-0 -z-10">
        <GlassNodeField mode="floor" density={0.18} horizonY={0.58} />
      </div>
      <div className="mx-auto flex min-h-full w-full min-w-0 max-w-[34rem] flex-col justify-center px-4 py-8 sm:py-12">
        {steps && steps.length > 1 && (
          <ol aria-label="Setup steps" className="mb-5 flex items-center justify-center gap-2">
            {steps.map((step, index) => {
              const state =
                index < currentIndex ? 'done' : index === currentIndex ? 'current' : 'next';
              return (
                <li
                  key={step.key}
                  aria-current={state === 'current' ? 'step' : undefined}
                  className="flex items-center gap-2"
                >
                  {index > 0 && (
                    <span
                      aria-hidden="true"
                      className={`h-px w-6 sm:w-10 ${state === 'next' ? 'bg-border-default' : 'bg-accent'}`}
                    />
                  )}
                  <span
                    className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ${
                      state === 'current'
                        ? 'sam-raised text-fg-primary'
                        : state === 'done'
                          ? 'text-success-fg'
                          : 'text-fg-muted'
                    }`}
                  >
                    {state === 'done' ? (
                      <Check className="h-3.5 w-3.5" aria-hidden="true" />
                    ) : (
                      <span
                        aria-hidden="true"
                        className={`h-1.5 w-1.5 rounded-full ${state === 'next' ? 'bg-fg-muted' : 'bg-accent'}`}
                      />
                    )}
                    {step.label}
                    {state === 'done' && <span className="sr-only"> (done)</span>}
                  </span>
                </li>
              );
            })}
          </ol>
        )}
        <section className="sam-glass sam-glass-rim rounded-[var(--sam-radius-pane)] px-5 py-7 sm:px-9 sm:py-9">
          {children}
        </section>
        {footer && <div className="mt-5 text-center text-xs text-fg-muted">{footer}</div>}
      </div>
    </main>
  );
}

/** SAM's mark with a slow glow behind it. The glow holds still for reduced motion. */
export function SetupHero({ celebrate = false }: { celebrate?: boolean }) {
  return (
    <div className="relative mx-auto mb-6 flex h-28 w-28 items-center justify-center sm:h-32 sm:w-32">
      <span
        aria-hidden="true"
        className="absolute inset-0 rounded-full bg-[radial-gradient(circle,rgb(132_204_22/0.45),rgb(34_197_94/0.12)_55%,transparent_72%)] blur-md motion-safe:animate-pulse"
      />
      {celebrate && (
        <span
          aria-hidden="true"
          className="absolute -inset-3 rounded-full border border-accent/40 motion-safe:animate-ping"
        />
      )}
      <img
        src="/sam-head.png"
        alt=""
        width={112}
        height={112}
        className="relative h-24 w-24 drop-shadow-[0_8px_24px_rgb(34_197_94/0.35)] sm:h-28 sm:w-28"
      />
    </div>
  );
}
