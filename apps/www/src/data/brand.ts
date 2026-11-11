/**
 * Content for the brand and style guide (/brand/).
 *
 * Colours that mirror a CSS token name it in `token`, with the theme the value belongs to;
 * tests/brand-guide.test.ts reads the stylesheets and fails if a value here drifts from the
 * token. Mascot and app-icon colours are sampled from the committed artwork
 * (public/images/sam-head.png and public/favicon.png), so they carry no token.
 */

export type SwatchGroup = 'brand' | 'mascot' | 'ground' | 'signal';

export interface Swatch {
  name: string;
  hex: string;
  group: SwatchGroup;
  role: string;
  token?: { name: string; theme: 'dark' | 'light' };
}

export const SWATCHES: readonly Swatch[] = [
  {
    name: 'SAM Green',
    hex: '#16a34a',
    group: 'brand',
    role: 'The brand colour. Primary actions, links, highlights and mascot backgrounds.',
    token: { name: '--color-accent', theme: 'dark' },
  },
  {
    name: 'Live Green',
    hex: '#22c55e',
    group: 'brand',
    role: 'Something is running or succeeded. Also the SAM wordmark on dark grounds.',
    token: { name: '--color-accent-strong', theme: 'dark' },
  },
  {
    name: 'Pressed Green',
    hex: '#15803d',
    group: 'brand',
    role: 'Hover and pressed states, and green text on light grounds.',
    token: { name: '--color-accent-hover', theme: 'dark' },
  },
  {
    name: 'Tile Green',
    hex: '#004222',
    group: 'brand',
    role: 'Behind the mascot on the app icon, avatars and social profiles.',
  },
  {
    name: 'Hair Lime',
    hex: '#86cc00',
    group: 'mascot',
    role: "The mascot's hair. Illustration only, never interface.",
  },
  { name: 'Hair Light', hex: '#bcfc54', group: 'mascot', role: 'Highlights in the hair.' },
  { name: 'Hair Shadow', hex: '#466200', group: 'mascot', role: 'Outlines and shade in the hair.' },
  {
    name: 'Void',
    hex: '#010302',
    group: 'ground',
    role: 'The deep centre every app screen floats over.',
    token: { name: '--sam-void-core', theme: 'dark' },
  },
  {
    name: 'Night',
    hex: '#070d0b',
    group: 'ground',
    role: 'Page background on the website.',
    token: { name: '--color-bg-body', theme: 'dark' },
  },
  {
    name: 'Pane',
    hex: '#13201d',
    group: 'ground',
    role: 'Cards, panels and other surfaces.',
    token: { name: '--color-bg-surface', theme: 'dark' },
  },
  {
    name: 'Rim',
    hex: '#29423b',
    group: 'ground',
    role: 'Borders and dividers.',
    token: { name: '--color-border', theme: 'dark' },
  },
  {
    name: 'Mist',
    hex: '#9fb7ae',
    group: 'ground',
    role: 'Secondary text on dark grounds.',
    token: { name: '--color-fg-muted', theme: 'dark' },
  },
  {
    name: 'Frost',
    hex: '#e6f2ee',
    group: 'ground',
    role: 'Main text on dark grounds.',
    token: { name: '--color-fg-primary', theme: 'dark' },
  },
  {
    name: 'Paper',
    hex: '#f8fbf8',
    group: 'ground',
    role: 'Surfaces in light mode.',
    token: { name: '--color-bg-surface', theme: 'light' },
  },
  {
    name: 'Forest Ink',
    hex: '#11271d',
    group: 'ground',
    role: 'Main text in light mode.',
    token: { name: '--color-fg-primary', theme: 'light' },
  },
  {
    name: 'Amber',
    hex: '#f59e0b',
    group: 'signal',
    role: 'Waiting on you: needs input, attention counts. Never decoration.',
    token: { name: '--color-warning', theme: 'dark' },
  },
  {
    name: 'Cyan',
    hex: '#22d3ee',
    group: 'signal',
    role: 'The first teammate to join a project.',
    token: { name: '--sam-person-1', theme: 'dark' },
  },
  {
    name: 'Violet',
    hex: '#a78bfa',
    group: 'signal',
    role: 'The second teammate.',
    token: { name: '--sam-person-2', theme: 'dark' },
  },
  {
    name: 'Rose',
    hex: '#fb7185',
    group: 'signal',
    role: 'The third teammate.',
    token: { name: '--sam-person-3', theme: 'dark' },
  },
  {
    name: 'Slate',
    hex: '#94a3b8',
    group: 'signal',
    role: 'Automations: schedules, triggers and other non-people.',
    token: { name: '--sam-person-auto', theme: 'dark' },
  },
];

/** WCAG relative luminance of a #rrggbb colour. */
export function luminance(hex: string): number {
  const value = hex.replace('#', '');
  if (!/^[0-9a-f]{6}$/i.test(value)) throw new Error(`Not a #rrggbb colour: ${hex}`);
  const [r, g, b] = [0, 2, 4].map((at) => {
    const channel = parseInt(value.slice(at, at + 2), 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two #rrggbb colours, 1 to 21. */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** `#16a34a` → `22 163 74`, the form CSS `rgb()` takes. */
export function rgbTriplet(hex: string): string {
  const value = hex.replace('#', '');
  return [0, 2, 4].map((at) => parseInt(value.slice(at, at + 2), 16)).join(' ');
}

export const LIGHT_TEXT = '#ffffff';
export const DARK_TEXT = '#070d0b';

/** The text colour that reads best on a swatch, with its contrast ratio. */
export function bestText(hex: string): { ink: string; ratio: number } {
  const onLight = contrastRatio(hex, LIGHT_TEXT);
  const onDark = contrastRatio(hex, DARK_TEXT);
  return onLight >= onDark
    ? { ink: LIGHT_TEXT, ratio: onLight }
    : { ink: DARK_TEXT, ratio: onDark };
}

/** WCAG grade for normal-size text. */
export function grade(ratio: number): 'AAA' | 'AA' | 'AA large' | 'Fail' {
  if (ratio >= 7) return 'AAA';
  if (ratio >= 4.5) return 'AA';
  if (ratio >= 3) return 'AA large';
  return 'Fail';
}

export interface TypeStep {
  name: string;
  sample: string;
  family: 'display' | 'body' | 'mono';
  size: string;
  weight: number;
  lineHeight: string;
  tracking: string;
  use: string;
  uppercase?: boolean;
}

/** Mirrors .hero-title, .section-title, .section-subtitle and .section-label in packages/ui/src/brand. */
export const TYPE_SCALE: readonly TypeStep[] = [
  {
    name: 'Display',
    sample: 'Agents on your own cloud',
    family: 'display',
    size: 'clamp(2.375rem, 4.6vw, 3.75rem)',
    weight: 600,
    lineHeight: '1.02',
    tracking: '-0.035em',
    use: 'One per page. The page title.',
  },
  {
    name: 'Section',
    sample: 'Every workspace in one place',
    family: 'display',
    size: 'clamp(1.75rem, 4vw, 2.5rem)',
    weight: 600,
    lineHeight: '1.2',
    tracking: '-0.01em',
    use: 'Section headings.',
  },
  {
    name: 'Card',
    sample: 'Compute pools',
    family: 'display',
    size: '1.25rem',
    weight: 600,
    lineHeight: '1.3',
    tracking: '0',
    use: 'Card and dialog titles.',
  },
  {
    name: 'Lead',
    sample: 'Start a task from your phone and review the pull request when it is done.',
    family: 'body',
    size: '1.125rem',
    weight: 400,
    lineHeight: '1.7',
    tracking: '0',
    use: 'The paragraph under a heading.',
  },
  {
    name: 'Body',
    sample: 'Each agent gets its own workspace, so two tasks never fight over one checkout.',
    family: 'body',
    size: '1rem',
    weight: 400,
    lineHeight: '1.6',
    tracking: '0',
    use: 'Everything people read.',
  },
  {
    name: 'Label',
    sample: 'Workspace · running',
    family: 'mono',
    size: '0.8125rem',
    weight: 500,
    lineHeight: '1.4',
    tracking: '0.1em',
    use: 'Small labels above headings, metadata.',
    uppercase: true,
  },
  {
    name: 'Code',
    sample: 'pnpm --filter @simple-agent-manager/www dev',
    family: 'mono',
    size: '0.875rem',
    weight: 400,
    lineHeight: '1.6',
    tracking: '0',
    use: 'Commands, IDs, hex values.',
  },
];

export interface Easing {
  name: string;
  curve: readonly [number, number, number, number];
  duration: number;
  use: string;
}

/** Curves already in use: glide (glass sheen, reveals), settle (drawers and sheets), pose (hero layers). */
export const EASINGS: readonly Easing[] = [
  { name: 'Glide', curve: [0.2, 0.8, 0.2, 1], duration: 900, use: 'Layers and sections arriving.' },
  { name: 'Settle', curve: [0.32, 0.72, 0, 1], duration: 320, use: 'Drawers, sheets and menus.' },
  {
    name: 'Spring',
    curve: [0.34, 1.56, 0.64, 1],
    duration: 520,
    use: 'Small things landing: chips, counts.',
  },
  { name: 'Linear', curve: [0, 0, 1, 1], duration: 900, use: 'Avoid. Only for progress bars.' },
];

export const cubicBezier = (curve: readonly number[]) => `cubic-bezier(${curve.join(', ')})`;

export interface CopyPair {
  context: string;
  avoid: string;
  write: string;
}

export const COPY_PAIRS: readonly CopyPair[] = [
  {
    context: 'Headline',
    avoid: 'Unleash the power of multi-agent AI orchestration.',
    write: 'Run Claude Code and Codex side by side, each in its own workspace.',
  },
  {
    context: 'Feature',
    avoid: 'Seamlessly supercharge your developer workflow from anywhere.',
    write: 'Start a task from your phone. Review the pull request when it is done.',
  },
  {
    context: 'Trust',
    avoid: 'Enterprise-grade infrastructure with blazing-fast performance.',
    write:
      'Workspaces run on servers in your own cloud account, and you pay your provider directly.',
  },
  {
    context: 'Error',
    avoid: 'Oops! Something went wrong.',
    write:
      'The workspace did not start because your Hetzner token was rejected. Update it in Settings, then try again.',
  },
];

export const BANNED_WORDS: readonly string[] = [
  'multi-agent',
  'seamless',
  'unleash',
  'supercharge',
  'revolutionary',
  'game-changing',
  'blazing fast',
  '10x',
  'next-gen',
  'magic',
];

export const GLOSSARY: readonly { term: string; meaning: string }[] = [
  {
    term: 'Project',
    meaning:
      'A GitHub repository plus everything SAM keeps for it: chats, tasks, ideas and activity.',
  },
  {
    term: 'Task',
    meaning: 'A piece of work you hand to an agent. SAM finds a place to run it and reports back.',
  },
  {
    term: 'Workspace',
    meaning: 'The isolated environment one agent works in, with your repository checked out.',
  },
  { term: 'Node', meaning: 'A server in your cloud that hosts one or more workspaces.' },
  {
    term: 'Agent profile',
    meaning: 'A saved setup for an agent: which agent, which model and how it should work.',
  },
  {
    term: 'Compute pool',
    meaning:
      'The cloud accounts and machine types SAM may use for your workspaces, in your order of preference.',
  },
];

export const SECTIONS = [
  { id: 'essence', label: 'Essence' },
  { id: 'logo', label: 'Logo' },
  { id: 'colour', label: 'Colour' },
  { id: 'type', label: 'Typography' },
  { id: 'material', label: 'Glass' },
  { id: 'motion', label: 'Motion' },
  { id: 'interface', label: 'Interface' },
  { id: 'voice', label: 'Voice' },
  { id: 'imagery', label: 'Imagery' },
  { id: 'assets', label: 'Assets' },
] as const;

export type SectionId = (typeof SECTIONS)[number]['id'];

/** "03" for the third section, so the page and the rail number chapters the same way. */
export function sectionNumber(id: SectionId): string {
  return String(SECTIONS.findIndex((section) => section.id === id) + 1).padStart(2, '0');
}
