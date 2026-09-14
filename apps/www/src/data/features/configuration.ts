import type { FeatureSection } from './types';

export const configurationSection: FeatureSection = {
  slug: 'configuration',
  label: 'Your Project, Your Way',
  title: 'Fully configurable.\nOpen source.',
  subtitle:
    'Upload reference docs, set default resource requirements, and pick a default agent — each project has its own settings for infrastructure and agent configuration.',
  summary:
    'Upload reference docs, set default resource requirements, and pick a default agent per project.',
  highlights: [
    'Upload reference docs and organize them with folders and tags',
    'Markdown renders inline, including Mermaid diagrams',
    'Set default resource requirements (vCPU, memory, disk) and a default agent per project',
    'Per-agent credential overrides configure API keys at the project level',
  ],
  docsHref: '/docs/guides/project-files/',
  group: 'govern',
  screenshots: [
    {
      src: '/images/features/library.png',
      alt: 'Library file browser showing a research folder, an uploaded markdown file with tags (architecture, missions, orchestration), and an Upload button',
      caption: 'File browser with folders, tags, sorting, and upload',
    },
    {
      src: '/images/features/document-viewer.png',
      alt: 'Document viewer rendering a markdown file with a Mermaid architecture diagram, plus Rendered/Source/Download toggle buttons',
      caption: 'Rendered markdown with Mermaid diagrams — toggle between rendered view and source',
    },
    {
      src: '/images/features/settings.png',
      alt: 'Project settings showing default resource requirements, the default agent type, and per-agent credential configuration',
      caption: 'Choose default resource requirements and an agent type per project',
    },
  ],
  details: [
    {
      headline: 'Project library',
      body: 'Upload architecture docs, research, and reference material. Files are organized with folders and tags. Agents can access library files as additional context during their work.',
      screenshot: {
        src: '/images/features/library.png',
        alt: 'Library showing a research folder with 1 subfolder and 1 tagged markdown file, plus filter, folder, and upload controls',
        caption: 'Folders, tags, and upload — agents can pull files from the library as context',
      },
    },
    {
      headline: 'Built-in document viewer',
      body: 'Markdown files render with full formatting, including Mermaid diagrams. Toggle between the rendered view and raw source, or download the file directly.',
      screenshot: {
        src: '/images/features/document-viewer.png',
        alt: 'Document viewer showing a rendered markdown file with a Mermaid architecture flowchart and Rendered/Source/Download buttons',
        caption: 'Rendered markdown with Mermaid diagram support — view source or download',
      },
    },
    {
      headline: 'Infrastructure and agent defaults',
      body: 'Set default resource requirements (vCPU, memory, disk) and a default agent type for each project — the baseline every task, trigger, skill, and profile inherits unless it sets its own. Per-agent credential overrides let you configure API keys at the project level.',
      screenshot: {
        src: '/images/features/settings.png',
        alt: 'Project settings showing default resource requirements, the default agent type, and per-agent credential configuration',
        caption:
          'Default resource requirements, agent selection, and per-agent credential overrides — all per project',
      },
    },
  ],
};
