/**
 * Code block settings for Expressive Code, which renders every Markdown code block on the
 * site (docs and blog). Passed to Starlight in `astro.config.ts`.
 */
import {
  type ExpressiveCodePlugin,
  LanguageGroups,
  type StarlightExpressiveCodeOptions,
} from '@astrojs/starlight/expressive-code';
import { pluginLineNumbers } from '@expressive-code/plugin-line-numbers';

/**
 * Fence languages that are not program code: plain text, command output, and Mermaid, which
 * `blog-mermaid.ts` and `docs-mermaid.ts` replace with a diagram. The empty string is a fence
 * with no language, usually a directory tree or an ASCII sketch.
 */
const NON_CODE_LANGUAGES = ['', 'mermaid', 'plain', 'plaintext', 'text', 'txt'];

/**
 * Languages whose blocks get no line numbers. Shell sessions are already drawn as a terminal
 * window, where numbered lines read like part of the command.
 */
const LANGUAGES_WITHOUT_LINE_NUMBERS = [...NON_CODE_LANGUAGES, ...LanguageGroups.terminal];

const LANGUAGE_NAMES: Readonly<Record<string, string>> = {
  astro: 'Astro',
  cjs: 'JavaScript',
  css: 'CSS',
  csv: 'CSV',
  diff: 'Diff',
  docker: 'Dockerfile',
  dockerfile: 'Dockerfile',
  env: '.env',
  glsl: 'GLSL',
  go: 'Go',
  graphql: 'GraphQL',
  hcl: 'HCL',
  html: 'HTML',
  http: 'HTTP',
  ini: 'INI',
  js: 'JavaScript',
  javascript: 'JavaScript',
  json: 'JSON',
  jsonc: 'JSON',
  jsx: 'JSX',
  md: 'Markdown',
  markdown: 'Markdown',
  mdx: 'MDX',
  mjs: 'JavaScript',
  py: 'Python',
  python: 'Python',
  rust: 'Rust',
  sql: 'SQL',
  svelte: 'Svelte',
  toml: 'TOML',
  ts: 'TypeScript',
  tsx: 'TSX',
  typescript: 'TypeScript',
  vue: 'Vue',
  xml: 'XML',
  yaml: 'YAML',
  yml: 'YAML',
};

/** Display name for a code block's language, or `undefined` when the block gets no tab. */
function languageTabName(language: string): string | undefined {
  const id = language.trim().toLowerCase();
  if (NON_CODE_LANGUAGES.includes(id) || LanguageGroups.terminal.includes(id)) return undefined;
  return LANGUAGE_NAMES[id] ?? id;
}

/**
 * Names the language of every untitled code block.
 *
 * Expressive Code draws an editor tab only when a block has a `title` (usually a file name),
 * so a plain ```typescript block gets no label. This plugin uses the language name as the
 * title of untitled editor blocks, which gives them the same tab as file-named blocks.
 * Terminal blocks keep their terminal window, and `frame="none"` is left alone.
 */
function pluginLanguageTab(): ExpressiveCodePlugin {
  return {
    name: 'SAM language tab',
    hooks: {
      // Runs after the frames plugin's own `preprocessCode`, which may already have taken a
      // title from a file-name comment on the first line.
      preprocessCode: ({ codeBlock }) => {
        const { props } = codeBlock;
        if (props.title !== undefined) return;
        if (props.frame === 'terminal' || props.frame === 'none') return;
        const name = languageTabName(codeBlock.language);
        if (name) props.title = name;
      },
    },
  };
}

/**
 * Line numbers in every code block except the languages above, and a language tab on untitled
 * ones. The gutter colour is raised to WCAG AA (4.5:1) on the docs and blog code backgrounds;
 * Expressive Code's default aims for about 3.5:1.
 */
export const expressiveCode: StarlightExpressiveCodeOptions = {
  plugins: [pluginLineNumbers(), pluginLanguageTab()],
  defaultProps: {
    showLineNumbers: true,
    overridesByLang: {
      [LANGUAGES_WITHOUT_LINE_NUMBERS.join(',')]: { showLineNumbers: false },
    },
  },
  styleOverrides: {
    gutterForeground: ({ theme }) => (theme.type === 'dark' ? '#7d8f99' : '#5b6c76'),
  },
};
