import { createGlassNodeField } from './scene/node-field.js';
const root = document.querySelector('[data-installer-field]');
if (root) {
  // A still composition: rich brand material, with no endless animation to pause.
  const field = createGlassNodeField(root, {
    mode: 'floor',
    seed: 11,
    density: 0.2,
    pitch: 58,
    vanishX: 0.65,
    horizonY: 0.42,
    zmax: 2600,
    focal: 820,
    reducedMotion: true,
  });
  field.start();
  addEventListener('pagehide', () => field.destroy(), { once: true });
}
