// Animated real-UI previews for the homepage feature sections, one JSON file per section
// (content, not code). Validated at module load so a mistyped step or a box outside its
// crop fails the build instead of shipping a broken animation. Images are generated from
// these specs by scripts/build-feature-scenes.ts.
import { MAX_STORY_MS, STEP_SETTLE_MS } from '../../lib/motion';
import type { SceneBox, SceneLayer, ScenePlace, SceneSpec } from './types';

import agentContext from './agent-context.json';
import chat from './chat.json';
import comments from './comments.json';
import computePools from './compute-pools.json';
import durableSessions from './durable-sessions.json';
import events from './events.json';
import multiplayer from './multiplayer.json';

export type {
  SceneBox,
  SceneLayer,
  SceneLight,
  SceneRing,
  ScenePlace,
  SceneSpec,
  SceneTile,
  SceneTone,
} from './types';

export { MAX_STORY_MS, STEP_SETTLE_MS };

/**
 * Furthest right a layer may reach, in percent of the stage. Perspective magnifies layers that
 * float in front of the window, so chips keep more margin than the window itself.
 */
export const MAX_RIGHT = { window: 99, chip: 96 };
/** Lowest a layer may reach, in percent of the stage (checked where image sizes are known). */
export const MAX_BOTTOM = 96;
/**
 * Tiles that appear in the same step rise one after another (FeatureScene.astro staggers them
 * 110 ms apart, each rising over 520 ms); more than this would outlast STEP_SETTLE_MS.
 */
export const MAX_TILES_PER_STEP = 5;

const TONES = new Set(['green', 'amber', 'mint', 'blue']);

function fail(slug: string, message: string): never {
  throw new Error(`Scene "${slug}": ${message}`);
}

function inside(outer: SceneBox, inner: SceneBox): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.w <= outer.x + outer.w &&
    inner.y + inner.h <= outer.y + outer.h
  );
}

function checkStep(slug: string, label: string, step: number, last: number) {
  if (!Number.isInteger(step) || step < 1 || step > last)
    fail(slug, `${label} step ${step} is outside 1..${last}`);
}

function checkLayer(slug: string, layer: SceneLayer, index: number, last: number) {
  const label = `layer "${layer.id}"`;
  if (index === 0 && (layer.depth !== 0 || layer.at !== undefined)) {
    fail(slug, 'the first layer is the main window: depth 0, present from the start');
  }
  if (layer.at !== undefined) checkStep(slug, label, layer.at, last);
  const maxRight = layer.depth > 0 ? MAX_RIGHT.chip : MAX_RIGHT.window;
  for (const place of [layer.place.wide, layer.place.narrow]) {
    if (place.x < 0 || place.y < 0 || place.w <= 0 || place.x + place.w > maxRight) {
      fail(slug, `${label} reaches past ${maxRight}% of the stage`);
    }
  }
  if (layer.glow && !TONES.has(layer.glow)) fail(slug, `${label} has an unknown glow`);
  const tiles = layer.tiles ?? [];
  for (const tile of tiles) {
    checkStep(slug, `${label} tile`, tile.at, last);
    if (!inside(layer.box, tile.box)) fail(slug, `${label} has a tile outside its box`);
    if (tiles.filter((other) => other.at === tile.at).length > MAX_TILES_PER_STEP) {
      fail(slug, `${label} has more than ${MAX_TILES_PER_STEP} tiles in step ${tile.at}`);
    }
  }
  for (const ring of layer.rings ?? []) {
    if (!TONES.has(ring.tone)) fail(slug, `${label} ring has an unknown tone`);
    if (ring.stops.length === 0) fail(slug, `${label} ring has no stops`);
    ring.stops.forEach((stop, i) => {
      checkStep(slug, `${label} ring`, stop.at, last);
      if (i > 0 && stop.at <= (ring.stops[i - 1]?.at ?? 0))
        fail(slug, `${label} ring stops must move forward`);
      if (!inside(layer.box, stop.box))
        fail(slug, `${label} ring outlines something outside its box`);
    });
    // Rings are transient: the resting frame shows only real UI.
    checkStep(slug, `${label} ring until`, ring.until, last);
    if (ring.until <= (ring.stops.at(-1)?.at ?? 0))
      fail(slug, `${label} ring ends before its last stop`);
  }
  if (layer.swap) {
    checkStep(slug, `${label} swap`, layer.swap.at, last);
    if (tiles.some((tile) => tile.at > (layer.swap?.at ?? 0)))
      fail(slug, `${label} swaps before all its tiles appear`);
  }
}

/** Validates one scene spec; throws with the scene's slug and the broken rule. */
export function asSceneSpec(candidate: unknown): SceneSpec {
  const spec = candidate as SceneSpec;
  const { slug, beats } = spec;
  if (beats.length === 0) fail(slug, 'needs at least one step');
  beats.forEach((ms, i) => {
    if (ms < 0 || (i > 0 && ms <= (beats[i - 1] ?? 0)))
      fail(slug, 'beats must start at 0 or later and increase');
  });
  const lastBeat = beats.at(-1) ?? 0;
  if (lastBeat + STEP_SETTLE_MS > MAX_STORY_MS) {
    fail(slug, `the story runs ${lastBeat + STEP_SETTLE_MS} ms; keep it within ${MAX_STORY_MS} ms`);
  }
  const last = beats.length;
  if (spec.layers.length === 0) fail(slug, 'needs a main window layer');
  const ids = new Set<string>();
  spec.layers.forEach((layer, i) => {
    if (ids.has(layer.id)) fail(slug, `duplicate layer id "${layer.id}"`);
    ids.add(layer.id);
    checkLayer(slug, layer, i, last);
  });
  for (const light of spec.lights ?? []) {
    if (!TONES.has(light.tone)) fail(slug, 'light has an unknown tone');
    checkStep(slug, 'light', light.at, last);
    if (light.until !== undefined) {
      checkStep(slug, 'light until', light.until, last);
      if (light.until <= light.at) fail(slug, 'a light must end after it starts');
    }
  }
  return spec;
}

export const scenes: SceneSpec[] = [
  chat,
  multiplayer,
  comments,
  computePools,
  events,
  durableSessions,
  agentContext,
].map(asSceneSpec);

export const sceneFor = (slug: string): SceneSpec | undefined =>
  scenes.find((scene) => scene.slug === slug);

/** Where a placed layer ends on its stage, in percent of the stage height. */
export function layerBottom(
  place: ScenePlace,
  stageAspect: number,
  image: { width: number; height: number }
): number {
  return place.y + (place.w * stageAspect * image.height) / image.width;
}

/** Throws if a layer, at its generated size, would hang below its stage in either composition. */
export function assertLayerFits(
  scene: SceneSpec,
  layer: SceneLayer,
  image: { width: number; height: number }
) {
  for (const layout of ['wide', 'narrow'] as const) {
    const bottom = layerBottom(layer.place[layout], scene.aspect[layout], image);
    if (bottom > MAX_BOTTOM) {
      fail(
        scene.slug,
        `layer "${layer.id}" reaches ${bottom.toFixed(1)}% of the ${layout} stage (max ${MAX_BOTTOM}%)`
      );
    }
  }
}
