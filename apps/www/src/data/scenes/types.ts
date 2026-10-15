/**
 * Animated real-UI preview ("scene") for a homepage feature section.
 *
 * Every pixel that looks like SAM is cut from a committed screenshot (source pixels, both
 * themes) by scripts/build-feature-scenes.ts; only timing is simulated. A scene is a short
 * story told in steps: step 0 is the intro, `beats[i]` is when step i + 1 begins, and the
 * last step is the resting frame — which is also what visitors without JavaScript or with
 * reduced motion see.
 */

/** A rectangle in source pixels. */
export interface SceneBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** green = working or done, amber = waiting on a person, mint = selection, blue = sleeping. */
export type SceneTone = 'green' | 'amber' | 'mint' | 'blue';

/** Where a layer sits on the stage: percent of the stage's width (x, w) and height (y). */
export interface ScenePlace {
  x: number;
  y: number;
  w: number;
}

/** A region of a layer that appears at step `at` (it is blank until then). */
export interface SceneTile {
  box: SceneBox;
  at: number;
}

/**
 * A highlight around a real UI element of its layer. It moves through its stops (one per
 * step it visits) and is gone by `until`, so the resting frame shows only real UI.
 */
export interface SceneRing {
  tone: SceneTone;
  stops: { at: number; box: SceneBox }[];
  until: number;
}

export interface SceneLayer {
  id: string;
  /** Screenshot base name in public/images/features (both themes exist). */
  source: string;
  box: SceneBox;
  /** Width of the generated image, about twice its largest display width. */
  outWidth: number;
  place: { wide: ScenePlace; narrow: ScenePlace };
  /** Distance in front of the main window, in px (0 for the window itself). */
  depth: number;
  /** Step at which the layer rises into place; omit for layers present from the start. */
  at?: number;
  tiles?: SceneTile[];
  rings?: SceneRing[];
  /** At step `at`, the layer crossfades to the same box of another capture (a later real state). */
  swap?: { source: string; at: number };
  /** Light cast behind the layer once it is in place. */
  glow?: SceneTone;
  /** Fades the layer out toward one edge where the crop cuts through wider UI. */
  fade?: 'right' | 'bottom';
}

/** Light on the stage's floor while a state holds; without `until` it stays in the resting frame. */
export interface SceneLight {
  tone: SceneTone;
  at: number;
  until?: number;
}

export interface SceneSpec {
  slug: string;
  /** Visible caption under the stage. */
  caption: string;
  /** What the animation shows, for screen readers. */
  description: string;
  /** Stage width ÷ height for the wide and narrow (phone) compositions. */
  aspect: { wide: number; narrow: number };
  /** Milliseconds after the scene starts at which steps 1..n begin. */
  beats: number[];
  /** The first layer is the main window; the rest float in front of it. */
  layers: SceneLayer[];
  lights?: SceneLight[];
}
