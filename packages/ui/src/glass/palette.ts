/**
 * Colours for the glass node field, per theme, plus the small canvas helpers that use them.
 * Dark glass glows additively ("lighter"); light glass draws normally at a lower glow gain so
 * lit tiles read as tinted glass rather than as light sources on a white page.
 */
export type GlassNodeFieldTheme = 'dark' | 'light';

export interface Palette {
  tile: string; tileAlpha: number; sheen: string; sheenAlpha: number;
  rim: string; rimAlpha: number; edge: string; edgeAlpha: number; bounceAlpha: number;
  slot: string; slotOn: number; slotOff: number;
  green: string; amber: string; core: string; spec: string;
  composite: GlobalCompositeOperation; glowGain: number;
}

export const PALETTES: Record<GlassNodeFieldTheme, Palette> = {
  dark: {
    tile: '9,18,15', tileAlpha: 0.6, sheen: '255,255,255', sheenAlpha: 0.022,
    rim: '255,255,255', rimAlpha: 0.05, edge: '255,255,255', edgeAlpha: 0.17, bounceAlpha: 0.13,
    slot: '255,255,255', slotOn: 0.035, slotOff: 0.012,
    green: '34,197,94', amber: '245,158,11', core: '215,255,228', spec: '235,255,242',
    composite: 'lighter', glowGain: 1,
  },
  light: {
    tile: '255,255,255', tileAlpha: 0.55, sheen: '255,255,255', sheenAlpha: 0.35,
    rim: '17,39,29', rimAlpha: 0.08, edge: '255,255,255', edgeAlpha: 0.95, bounceAlpha: 0.2,
    slot: '17,39,29', slotOn: 0.06, slotOff: 0.025,
    green: '22,163,74', amber: '217,119,6', core: '240,255,245', spec: '255,255,255',
    composite: 'source-over', glowGain: 0.55,
  },
};

export const rgba = (rgb: string, alpha: number) => `rgba(${rgb},${Math.max(0, Math.min(1, alpha))})`;

/** A soft round glow, drawn once per colour and stamped with drawImage. */
export function sprite(rgb: string): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 128;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
    g.addColorStop(0, rgba(rgb, 0.95));
    g.addColorStop(0.18, rgba(rgb, 0.5));
    g.addColorStop(0.5, rgba(rgb, 0.13));
    g.addColorStop(1, rgba(rgb, 0));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 128, 128);
  }
  return canvas;
}

/** The page theme: the site's `data-theme`, the app's `data-ui-theme`, else the OS preference. */
export function detectTheme(): GlassNodeFieldTheme {
  const root = document.documentElement;
  const site = root.getAttribute('data-theme');
  if (site === 'light' || site === 'dark') return site;
  const app = root.getAttribute('data-ui-theme');
  if (app) return app.includes('light') ? 'light' : 'dark';
  return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}
