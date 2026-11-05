/**
 * PROTOTYPE — two directions for the account map. Never merge to main.
 *
 * Query params:
 *   - `v`      — `a` (Right now: attention + machines) or `b` (Connections: linked columns)
 *   - `scene`  — `normal` | `busy` | `empty`
 *   - `bare`   — hides the prototype switcher (for screenshots)
 */
import { useSearchParams } from 'react-router';

import { useIsMobile } from '../../hooks/useIsMobile';
import { DirectionA } from './direction-a';
import { DirectionB } from './direction-b';
import { type SceneKey,SCENES } from './mock-data';
import { PrototypeFrame } from './parts';

export function AccountMapPrototype() {
  const [params, setParams] = useSearchParams();
  const isMobile = useIsMobile();
  const variant = params.get('v') === 'b' ? 'b' : 'a';
  const sceneKey = (params.get('scene') ?? 'normal') as SceneKey;
  const scene = SCENES[sceneKey] ?? SCENES.normal;
  const set = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    next.set(key, value);
    setParams(next, { replace: true });
  };

  return (
    <PrototypeFrame isMobile={isMobile}>
      {variant === 'a' ? <DirectionA key={sceneKey} scene={scene} isMobile={isMobile} /> : <DirectionB key={sceneKey} scene={scene} isMobile={isMobile} />}
      {!params.has('bare') && (
        <div className="fixed bottom-3 left-1/2 z-50 flex -translate-x-1/2 gap-1 rounded-full bg-[var(--sam-chip-bg)] p-1 text-xs shadow-lg">
          {(['a', 'b'] as const).map((v) => (
            <button key={v} type="button" onClick={() => set('v', v)} className={`cursor-pointer rounded-full border-0 px-3 py-1.5 ${variant === v ? 'bg-[var(--sam-status-success-bg)] text-[var(--sam-status-success-fg)]' : 'bg-transparent text-fg-muted'}`}>
              {v === 'a' ? 'A · Right now' : 'B · Connections'}
            </button>
          ))}
          {(Object.keys(SCENES) as SceneKey[]).map((s) => (
            <button key={s} type="button" onClick={() => set('scene', s)} className={`cursor-pointer rounded-full border-0 px-2.5 py-1.5 ${sceneKey === s ? 'text-fg-primary underline' : 'bg-transparent text-fg-muted'} bg-transparent`}>
              {s}
            </button>
          ))}
        </div>
      )}
    </PrototypeFrame>
  );
}
