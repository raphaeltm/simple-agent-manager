export interface FeatureScreenshot {
  src: string;
  alt: string;
  caption: string;
}

export type FeatureGroup = 'collaborate' | 'run' | 'automate' | 'govern';

export interface FeatureSection {
  slug: string;
  label: string;
  title: string;
  subtitle: string;
  /** One-line summary used on the /features/ index cards. */
  summary: string;
  /** 3-5 concrete bullets rendered as a checklist on the feature detail page. */
  highlights: string[];
  /** Link to the relevant public guide, rendered as "Read the guide" on the detail page. */
  docsHref?: string;
  group: FeatureGroup;
  /** Hero image for the detail page and the /features/ index card; only the first entry is rendered. */
  screenshots: FeatureScreenshot[];
  details: {
    headline: string;
    body: string;
    screenshot: FeatureScreenshot;
  }[];
}

export const featureGroups: { id: FeatureGroup; label: string }[] = [
  { id: 'collaborate', label: 'Collaborate' },
  { id: 'run', label: 'Run' },
  { id: 'automate', label: 'Automate' },
  { id: 'govern', label: 'Govern' },
];
