/**
 * PROTOTYPE — slimmer mobile chat header. Never merge to main.
 *
 * Query params:
 *   - `v`      — `now` (production layout), `a` (one line + sheet), `b` (slim strip)
 *   - `title`  — `normal` | `short` | `long`
 *   - `bare`   — hides the variant switcher (for recordings)
 */
import { useCallback, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';

import { MockAppBar, MockComposer, MockConversation } from './frame';
import { MOCK_MESSAGES, MOCK_TITLES, type MockTitleKey } from './mock-data';
import { CurrentHeader, OneLineHeader, SlimStripHeader } from './variants';

type Variant = 'now' | 'a' | 'b';

const VARIANT_LABELS: Record<Variant, string> = {
  now: 'Today',
  a: 'A · One line',
  b: 'B · Slim strip',
};

/** Pixels of downward scroll before B tucks its chip row away. */
const COLLAPSE_AFTER_PX = 24;

export function ChatHeaderPrototype() {
  const [params, setParams] = useSearchParams();
  const variant = (['now', 'a', 'b'].includes(params.get('v') ?? '') ? params.get('v') : 'now') as Variant;
  const titleKey = (params.get('title') ?? 'normal') as MockTitleKey;
  const title = MOCK_TITLES[titleKey] ?? MOCK_TITLES.normal;
  const bare = params.has('bare');

  const [publicPorts, setPublicPorts] = useState(true);
  const togglePublicPorts = useCallback(() => setPublicPorts((v) => !v), []);

  // B: hide the chip row while reading down, bring it back on any upward scroll.
  const [collapsed, setCollapsed] = useState(false);
  const lastTop = useRef(0);
  const travel = useRef(0);
  const onScroll = useCallback((event: React.UIEvent<HTMLDivElement>) => {
    const top = event.currentTarget.scrollTop;
    const delta = top - lastTop.current;
    lastTop.current = top;
    travel.current = Math.sign(delta) === Math.sign(travel.current) ? travel.current + delta : delta;
    if (travel.current > COLLAPSE_AFTER_PX) setCollapsed(true);
    else if (travel.current < -COLLAPSE_AFTER_PX || top <= 0) setCollapsed(false);
  }, []);

  const headerProps = { title, publicPorts, onTogglePublicPorts: togglePublicPorts };

  return (
    <div style={{ height: '100dvh', overflow: 'hidden' }} className="flex flex-col gap-2 p-2">
      <style>{'@keyframes proto-strip-in{from{opacity:0;transform:translateY(-6px)}to{opacity:1;transform:none}}'}</style>
      <MockAppBar />
      {variant === 'now' && <CurrentHeader {...headerProps} />}
      {variant === 'a' && <OneLineHeader {...headerProps} />}
      {variant === 'b' && <SlimStripHeader {...headerProps} collapsed={collapsed} />}
      <MockConversation messages={MOCK_MESSAGES} onScroll={variant === 'b' ? onScroll : undefined} />
      <MockComposer
        footer={
          bare ? null : (
            <div className="flex justify-center gap-1" role="tablist" aria-label="Prototype variant">
              {(Object.keys(VARIANT_LABELS) as Variant[]).map((key) => (
                <button
                  key={key}
                  type="button"
                  role="tab"
                  aria-selected={variant === key}
                  onClick={() => {
                    const next = new URLSearchParams(params);
                    next.set('v', key);
                    setParams(next, { replace: true });
                    setCollapsed(false);
                  }}
                  className={`h-7 cursor-pointer rounded-full border-none px-3 text-xs ${variant === key ? 'bg-[var(--sam-status-success-bg)] text-[var(--sam-status-success-fg)]' : 'bg-transparent text-fg-muted'}`}
                >
                  {VARIANT_LABELS[key]}
                </button>
              ))}
            </div>
          )
        }
      />
    </div>
  );
}
