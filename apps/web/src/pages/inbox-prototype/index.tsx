/**
 * PROTOTYPE ONLY — /prototype/inbox. Three directions for a unified Inbox (idea
 * 01M7G03ZCQ6TM6CMEYDRKQ8ST9) over one mock data set. Dev-only route, no API, no auth.
 * Must be removed before any merge to main (.claude/rules/37-prototype-development.md).
 *
 * ?direction=a|b|c  ?scene=<name> (see SCENES in model.ts)  ?clean=1 hides these controls.
 */
import { useReducer } from 'react';
import { useSearchParams } from 'react-router';

import { useIsMobile } from '../../hooks/useIsMobile';
import { DirectionA } from './direction-a';
import { DirectionB } from './direction-b';
import { DirectionC } from './direction-c';
import { installMockApi } from './mock-api';
import { type Direction, reducer, SCENES, sceneState } from './model';

installMockApi();

export function InboxPrototype() {
  const [params, setParams] = useSearchParams();
  const direction = (
    ['a', 'b', 'c'].includes(params.get('direction') ?? '') ? params.get('direction') : 'a'
  ) as Direction;
  const scene = params.get('scene');
  const clean = params.get('clean') === '1';
  const [state, dispatch] = useReducer(reducer, scene, sceneState);
  const mobile = useIsMobile();
  const go = (next: Record<string, string>) => {
    window.location.search = new URLSearchParams({
      direction,
      ...(scene ? { scene } : {}),
      ...next,
    }).toString();
  };

  const View = direction === 'b' ? DirectionB : direction === 'c' ? DirectionC : DirectionA;
  return (
    <>
      <View key={`${direction}-${scene}`} state={state} dispatch={dispatch} mobile={mobile} />
      {!clean && (
        <div className="fixed bottom-2 left-1/2 z-[200] flex -translate-x-1/2 items-center gap-1.5 rounded-full bg-black/75 px-2.5 py-1 text-[11px] whitespace-nowrap text-white">
          {(['a', 'b', 'c'] as const).map((d) => (
            <button
              key={d}
              type="button"
              onClick={() => go({ direction: d })}
              className={`cursor-pointer rounded-full border-0 px-2 py-0.5 text-white ${d === direction ? 'bg-white/35' : 'bg-white/10'}`}
            >
              {d.toUpperCase()}
            </button>
          ))}
          <select
            aria-label="Scene"
            value={scene ?? 'home'}
            onChange={(e) => go({ scene: e.target.value })}
            className="max-w-[96px] rounded bg-white/15 text-white"
          >
            {Object.keys(SCENES).map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => setParams({ direction, ...(scene ? { scene } : {}), clean: '1' })}
            className="cursor-pointer border-0 bg-transparent text-white/70"
          >
            hide
          </button>
        </div>
      )}
    </>
  );
}
