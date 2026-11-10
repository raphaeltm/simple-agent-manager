import { GlassNodeField } from '@simple-agent-manager/ui';
import type { ReactNode } from 'react';

interface SetupShellProps {
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
export function SetupShell({ footer, children }: SetupShellProps) {
  return (
    <main
      data-testid="setup-scroll"
      className="relative isolate h-[var(--sam-app-height)] overflow-y-auto overflow-x-hidden bg-canvas text-fg-primary"
    >
      <div className="pointer-events-none fixed inset-0 -z-10">
        <GlassNodeField mode="floor" density={0.18} horizonY={0.58} />
      </div>
      <div className="mx-auto flex min-h-full w-full min-w-0 max-w-[34rem] flex-col justify-center px-4 py-8 sm:py-12">
        <section className="sam-glass sam-glass-rim rounded-[var(--sam-radius-pane)] px-5 py-7 sm:px-9 sm:py-9">
          {children}
        </section>
        {footer && <div className="mt-5 text-center text-xs text-fg-muted">{footer}</div>}
      </div>
    </main>
  );
}
