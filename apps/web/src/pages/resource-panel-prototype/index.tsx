/**
 * Index for the Resources-panel prototypes.
 *
 * Mobile-first: one column of large tappable cards, each stating the trade it
 * makes so the choice is between designs rather than between screenshots.
 */
import type { LucideIcon } from 'lucide-react';
import { Activity, ChevronRight, LayoutPanelTop, PanelBottom } from 'lucide-react';
import { Link } from 'react-router';

import { PROTOTYPE_INDEX_PATH, PrototypeFrame } from './prototype-chrome';

interface VariantCard {
  path: string;
  letter: string;
  title: string;
  icon: LucideIcon;
  gain: string;
  cost: string;
}

const VARIANTS: VariantCard[] = [
  {
    path: `${PROTOTYPE_INDEX_PATH}/a`,
    letter: 'A',
    title: 'Sibling drawer',
    icon: LayoutPanelTop,
    gain: 'Identical to Comments and Timeline — same surface, same close button, and it scrolls.',
    cost: 'The chart still sits below a chunk list, so a phone needs two scrolls to reach it.',
  },
  {
    path: `${PROTOTYPE_INDEX_PATH}/b`,
    letter: 'B',
    title: 'Bottom sheet',
    icon: PanelBottom,
    gain: 'Opens half-height over the chat: peak RAM and OOM at a glance without leaving the thread.',
    cost: 'A second interaction model in the tool rail, and drag gestures need care next to a scroller.',
  },
  {
    path: `${PROTOTYPE_INDEX_PATH}/c`,
    letter: 'C',
    title: 'Inspector',
    icon: Activity,
    gain: 'Pinned stats, a segment switcher, and the chart first at twice the height.',
    cost: 'Diverges from the sibling panels, and splitting content across segments hides some of it.',
  },
];

export function ResourcePanelPrototypeIndex() {
  return (
    <PrototypeFrame>
      <main className="mx-auto w-full max-w-2xl px-4 py-6">
        <p className="m-0 text-[11px] font-semibold uppercase tracking-[0.14em] text-fg-muted">
          Prototype
        </p>
        <h1 className="m-0 mt-1 text-xl font-semibold text-fg-primary">Session Resources panel</h1>
        <p className="m-0 mt-3 text-sm leading-relaxed text-fg-muted">
          The shipped Resources panel cannot scroll on a phone: it is a
          <code className="mx-1 rounded bg-inset px-1 py-0.5 text-xs">&lt;dialog&gt;</code>
          with no explicit height, so the UA&apos;s
          <code className="mx-1 rounded bg-inset px-1 py-0.5 text-xs">height: fit-content</code>
          sized it to its contents — measured at 1069px inside a 667px viewport — and
          <code className="mx-1 rounded bg-inset px-1 py-0.5 text-xs">overflow: hidden</code>
          clipped the rest. Its inner scroller never overflows, so there is nothing to scroll. It
          also uses an opaque surface and an oversized close button where every sibling panel uses
          glass and a compact one. Three ways to fix it:
        </p>

        <ul className="m-0 mt-5 flex list-none flex-col gap-3 p-0">
          {VARIANTS.map((variant) => (
            <li key={variant.path}>
              <Link
                to={variant.path}
                data-testid={`prototype-variant-${variant.letter.toLowerCase()}`}
                className="flex min-h-14 items-start gap-3 rounded-xl border border-border-default bg-surface p-3.5 no-underline transition-colors hover:bg-surface-hover"
              >
                <span
                  aria-hidden="true"
                  className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent"
                >
                  <variant.icon size={18} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="text-sm font-semibold text-fg-primary">
                      {variant.letter} · {variant.title}
                    </span>
                  </span>
                  <span className="mt-1.5 block text-xs leading-relaxed text-fg-muted break-words">
                    <strong className="font-semibold text-fg-primary">Gains:</strong> {variant.gain}
                  </span>
                  <span className="mt-1 block text-xs leading-relaxed text-fg-muted break-words">
                    <strong className="font-semibold text-fg-primary">Costs:</strong> {variant.cost}
                  </span>
                </span>
                <ChevronRight
                  size={16}
                  className="mt-1 shrink-0 text-fg-muted"
                  aria-hidden="true"
                />
              </Link>
            </li>
          ))}
        </ul>

        <p className="m-0 mt-5 text-xs leading-relaxed text-fg-muted">
          Each variant opens over a stand-in of the mobile chat with the real session tool rail. Tap
          the Resources icon on the right edge to open the panel; the toolbar at the top switches
          between the Rich, Huge, Empty and Error datasets.
        </p>
      </main>
    </PrototypeFrame>
  );
}
