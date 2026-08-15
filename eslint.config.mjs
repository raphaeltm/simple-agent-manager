import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import eslintPluginAstro from 'eslint-plugin-astro';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import simpleImportSort from 'eslint-plugin-simple-import-sort';
import globals from 'globals';
import tseslint from 'typescript-eslint';

import samPlugin from './packages/eslint-plugin-sam/src/index.js';

const typescriptFiles = ['**/*.{ts,tsx,mts,cts}'];
const astroFiles = ['**/*.astro'];
const samPluginFiles = ['packages/eslint-plugin-sam/**/*.js'];
// Promoted to error 2026-08-11 (ai-slop debt burn-down, see
// tasks/archive/2026-08-10-ai-slop-debt-burndown.md): production sites for all
// three rules were at zero. Test files are exempted below (testFileGlobs
// block) because test-double typing is idiomatic and these rules target
// production request/row-narrowing patterns.
const samBlockingRules = {
  'sam/no-local-record-guard': 'error',
  'sam/no-unsafe-json-parse-assertion': 'error',
  'sam/no-unvalidated-request-json': 'error',
};
// Onboarding workspaces that had no lint path before the deterministic
// runtime-boundary rollout (see rules.manifest.json / scripts/quality/README.md).
// Reused below both to force most rules advisory and to re-promote the two
// already-clean rules (no-explicit-any, no-non-null-assertion) to error.
const onboardingAdvisoryFiles = [
  'apps/www/**/*.{ts,tsx,mts,cts,astro}',
  'apps/tail-worker/**/*.{ts,tsx,mts,cts}',
  'infra/**/*.{ts,tsx,mts,cts}',
  'packages/cloud-init/**/*.{ts,tsx,mts,cts}',
  'tools/og-image/**/*.{ts,tsx,mts,cts}',
];
// Test-double typing (mocks, fixtures, assertion helpers) idiomatically needs
// `any` and non-null assertions, and the sam/* runtime-boundary trio targets
// production request/row-narrowing patterns that don't apply to test setup.
// De-scoped 2026-08-11 (ai-slop debt burn-down) after confirming production
// source was clean at zero for all five rules; see
// tasks/archive/2026-08-10-ai-slop-debt-burndown.md.
const testFileGlobs = ['**/tests/**', '**/*.test.{ts,tsx,mts,cts}', '**/*.spec.{ts,tsx,mts,cts}'];

const upstreamNoUnusedVars = tseslint.plugin.rules['no-unused-vars'];
const noUnusedVarsEslint8Compat = {
  ...upstreamNoUnusedVars,
  create(context) {
    const report = context.report.bind(context);
    const compatContext = Object.create(context);
    Object.defineProperty(compatContext, 'report', {
      value: (descriptor) => {
        // typescript-eslint 8 deliberately started reporting runtime values
        // referenced only by a type-level `typeof`. Preserve the audited v7
        // behavior during the rule-neutral ESLint 9 host migration.
        if (descriptor.messageId !== 'usedOnlyAsType') {
          report(descriptor);
        }
      },
      writable: false,
    });

    return upstreamNoUnusedVars.create(compatContext);
  },
};

const typescriptEslintCompatPlugin = {
  ...tseslint.plugin,
  rules: {
    ...tseslint.plugin.rules,
    'no-unused-vars': noUnusedVarsEslint8Compat,
  },
};

const withSeverity = (ruleConfig, severity) =>
  Array.isArray(ruleConfig) ? [severity, ...ruleConfig.slice(1)] : severity;

// Like withSeverity, but also merges extra options onto whatever options the
// recommended preset already sets for the rule (if any), instead of
// discarding them. Used to both promote severity AND fix false positives for
// apps/web-specific patterns (see the apps/web jsx-a11y block below).
const withSeverityAndOptions = (ruleConfig, severity, extraOptions) => {
  const existingOptions = Array.isArray(ruleConfig) ? ruleConfig[1] : undefined;
  return [severity, { ...existingOptions, ...extraOptions }];
};

// ESLint 9 and typescript-eslint 8 are the supported flat-config host. Keep
// the ESLint 8 / typescript-eslint 7 recommended semantics during this
// foundation migration; the parity evidence for the audited repository must
// change only when a later rule rollout says so explicitly.
const legacyJsRecommendedRules = {
  ...js.configs.recommended.rules,
  'no-constant-binary-expression': 'off',
  'no-empty-static-block': 'off',
  'no-extra-semi': 'error',
  'no-inner-declarations': 'error',
  'no-mixed-spaces-and-tabs': 'error',
  'no-new-native-nonconstructor': 'off',
  'no-new-symbol': 'error',
  'no-unused-private-class-members': 'off',
};

const legacyTypescriptRecommendedRules = {
  ...tseslint.configs.recommended.at(-1).rules,
  '@typescript-eslint/no-empty-object-type': ['error', { allowInterfaces: 'always' }],
  '@typescript-eslint/no-require-imports': 'off',
  '@typescript-eslint/no-unsafe-function-type': 'error',
  '@typescript-eslint/no-unused-expressions': 'off',
  '@typescript-eslint/no-var-requires': 'error',
  '@typescript-eslint/no-wrapper-object-types': 'error',
  '@typescript-eslint/prefer-namespace-keyword': 'off',
  'no-unused-expressions': 'off',
};

const onboardingAdvisoryRules = Object.fromEntries(
  Object.entries({
    ...legacyJsRecommendedRules,
    ...tseslint.configs.eslintRecommended.rules,
    ...legacyTypescriptRecommendedRules,
    '@typescript-eslint/consistent-type-imports': [
      'error',
      {
        disallowTypeAnnotations: false,
        fixStyle: 'inline-type-imports',
        prefer: 'type-imports',
      },
    ],
    '@typescript-eslint/no-explicit-any': 'warn',
    '@typescript-eslint/no-non-null-assertion': 'warn',
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    'no-var': 'error',
    'simple-import-sort/exports': 'error',
    'simple-import-sort/imports': 'error',
  }).map(([name, config]) => [
    name,
    config === 'off' || config === 0 ? config : withSeverity(config, 'warn'),
  ])
);

export default defineConfig([
  {
    ignores: [
      '**/coverage/**',
      '**/dist/**',
      '**/build/**',
      '**/node_modules/**',
      '**/.turbo/**',
      '**/*.cjs',
      '**/*.min.js',
    ],
    linterOptions: {
      reportUnusedDisableDirectives: 'off',
    },
  },
  {
    files: samPluginFiles,
    languageOptions: {
      ecmaVersion: 'latest',
      globals: globals.node,
      sourceType: 'module',
    },
    rules: legacyJsRecommendedRules,
  },
  {
    files: typescriptFiles,
    rules: legacyJsRecommendedRules,
  },
  {
    files: typescriptFiles,
    languageOptions: {
      parser: tseslint.parser,
      sourceType: 'module',
    },
    plugins: {
      '@typescript-eslint': typescriptEslintCompatPlugin,
    },
  },
  {
    ...tseslint.configs.eslintRecommended,
    files: typescriptFiles,
    rules: {
      ...tseslint.configs.eslintRecommended.rules,
      'no-class-assign': 'error',
      'no-with': 'error',
    },
  },
  {
    files: typescriptFiles,
    languageOptions: {
      ecmaVersion: 'latest',
      globals: {
        ...globals.browser,
        ...globals.es2022,
        ...globals.node,
      },
      parserOptions: {
        sourceType: 'module',
      },
    },
    plugins: {
      'react-hooks': reactHooks,
      sam: samPlugin,
      'simple-import-sort': simpleImportSort,
    },
    rules: {
      ...legacyTypescriptRecommendedRules,
      '@typescript-eslint/consistent-type-imports': [
        'error',
        {
          disallowTypeAnnotations: false,
          fixStyle: 'inline-type-imports',
          prefer: 'type-imports',
        },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'simple-import-sort/exports': 'error',
      'simple-import-sort/imports': 'error',
      ...samBlockingRules,
    },
  },
  ...eslintPluginAstro.configs['flat/base'],
  {
    files: astroFiles,
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.es2022,
        ...globals.node,
      },
      parserOptions: {
        parser: tseslint.parser,
      },
    },
    plugins: {
      '@typescript-eslint': typescriptEslintCompatPlugin,
      sam: samPlugin,
      'simple-import-sort': simpleImportSort,
    },
    rules: {
      ...legacyTypescriptRecommendedRules,
      '@typescript-eslint/consistent-type-imports': [
        'error',
        {
          disallowTypeAnnotations: false,
          fixStyle: 'inline-type-imports',
          prefer: 'type-imports',
        },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'simple-import-sort/exports': 'error',
      'simple-import-sort/imports': 'error',
      ...samBlockingRules,
    },
  },
  {
    files: ['**/*.tsx'],
    languageOptions: {
      parserOptions: {
        ecmaFeatures: {
          jsx: true,
        },
      },
    },
    plugins: {
      'jsx-a11y': jsxA11y,
      react,
      'react-hooks': reactHooks,
    },
    rules: {
      ...react.configs.recommended.rules,
      ...jsxA11y.configs.recommended.rules,
      'jsx-a11y/aria-role': withSeverity(
        jsxA11y.configs.recommended.rules['jsx-a11y/aria-role'],
        'warn'
      ),
      'jsx-a11y/click-events-have-key-events': withSeverity(
        jsxA11y.configs.recommended.rules['jsx-a11y/click-events-have-key-events'],
        'warn'
      ),
      'jsx-a11y/interactive-supports-focus': withSeverity(
        jsxA11y.configs.recommended.rules['jsx-a11y/interactive-supports-focus'],
        'warn'
      ),
      'jsx-a11y/label-has-associated-control': withSeverity(
        jsxA11y.configs.recommended.rules['jsx-a11y/label-has-associated-control'],
        'warn'
      ),
      'jsx-a11y/no-autofocus': withSeverity(
        jsxA11y.configs.recommended.rules['jsx-a11y/no-autofocus'],
        'warn'
      ),
      'jsx-a11y/no-interactive-element-to-noninteractive-role': withSeverity(
        jsxA11y.configs.recommended.rules['jsx-a11y/no-interactive-element-to-noninteractive-role'],
        'warn'
      ),
      'jsx-a11y/no-noninteractive-element-interactions': withSeverity(
        jsxA11y.configs.recommended.rules['jsx-a11y/no-noninteractive-element-interactions'],
        'warn'
      ),
      'jsx-a11y/no-static-element-interactions': withSeverity(
        jsxA11y.configs.recommended.rules['jsx-a11y/no-static-element-interactions'],
        'warn'
      ),
      'react/jsx-no-constructed-context-values': 'error',
      'react/prop-types': 'off',
      'react/react-in-jsx-scope': 'off',
      'react-hooks/exhaustive-deps': 'warn',
      'react-hooks/rules-of-hooks': 'error',
    },
    settings: {
      react: {
        version: 'detect',
      },
    },
  },
  {
    // apps/web (the control-plane UI) has zero jsx-a11y violations as of the
    // 2026-08-11 a11y burndown (see tasks/archive/2026-04-01-promote-a11y-eslint-to-errors.md).
    // Promote the jsx-a11y family from warn to error here so regressions fail
    // CI. Other tsx-bearing workspaces (packages/acp-client, and the
    // onboarding-advisory workspaces below) keep the shared 'warn' baseline
    // from the block above until they receive the same cleanup.
    //
    // Two rules also get extra options merged in on top of the recommended
    // preset's own options, fixing real false positives rather than masking
    // findings:
    //   - aria-role: ignoreNonDOM skips the `role` attribute check for custom
    //     React components (e.g. `<MessageBubble role="user" />`, where
    //     `role` is a component prop unrelated to ARIA, never forwarded to a
    //     DOM node). It never skips a literal `role="..."` on a real DOM
    //     element, so it cannot hide a genuine invalid-role bug.
    //   - label-has-associated-control: controlComponents teaches the rule
    //     that `<Input>` (packages/ui, a thin wrapper that always renders a
    //     native `<input>` and forwards all props) is a real form control
    //     when nested in a `<label>` — the same implicit-association
    //     technique as native `<label><input/></label>`. depth raises the
    //     default nesting search from 2 to 3 so the rule can see label text
    //     that renders through one extra wrapper element (verified against
    //     the exact JSX shape in apps/web before choosing this value).
    files: ['apps/web/**/*.tsx'],
    rules: {
      'jsx-a11y/aria-role': withSeverityAndOptions(
        jsxA11y.configs.recommended.rules['jsx-a11y/aria-role'],
        'error',
        { ignoreNonDOM: true }
      ),
      'jsx-a11y/click-events-have-key-events': withSeverity(
        jsxA11y.configs.recommended.rules['jsx-a11y/click-events-have-key-events'],
        'error'
      ),
      'jsx-a11y/interactive-supports-focus': withSeverity(
        jsxA11y.configs.recommended.rules['jsx-a11y/interactive-supports-focus'],
        'error'
      ),
      'jsx-a11y/label-has-associated-control': withSeverityAndOptions(
        jsxA11y.configs.recommended.rules['jsx-a11y/label-has-associated-control'],
        'error',
        { controlComponents: ['Input'], depth: 3 }
      ),
      'jsx-a11y/no-autofocus': withSeverity(
        jsxA11y.configs.recommended.rules['jsx-a11y/no-autofocus'],
        'error'
      ),
      'jsx-a11y/no-interactive-element-to-noninteractive-role': withSeverity(
        jsxA11y.configs.recommended.rules['jsx-a11y/no-interactive-element-to-noninteractive-role'],
        'error'
      ),
      'jsx-a11y/no-noninteractive-element-interactions': withSeverity(
        jsxA11y.configs.recommended.rules['jsx-a11y/no-noninteractive-element-interactions'],
        'error'
      ),
      'jsx-a11y/no-static-element-interactions': withSeverity(
        jsxA11y.configs.recommended.rules['jsx-a11y/no-static-element-interactions'],
        'error'
      ),
    },
  },
  {
    files: ['apps/api/src/**/*.ts'],
    ignores: ['apps/api/src/lib/logger.ts'],
    rules: {
      'no-console': 'error',
    },
  },
  {
    // These five workspaces had no lint path before this rollout. Preserve all
    // newly surfaced findings as advisory while fatal parser/config failures
    // remain blocking; debt cleanup can promote individual rules deliberately.
    files: onboardingAdvisoryFiles,
    rules: onboardingAdvisoryRules,
  },
  {
    // apps/www, apps/tail-worker, infra, packages/cloud-init, and
    // tools/og-image have zero `!`/`any` findings in production source as of
    // the 2026-08-11 ai-slop debt burn-down (see
    // tasks/archive/2026-08-10-ai-slop-debt-burndown.md). The onboarding-advisory
    // block above force-downgrades every rule (including these two) to `warn`
    // for its broader "no lint path existed before this rollout" rationale;
    // re-promote just these two already-clean rules to `error` here so new
    // debt in these workspaces is caught the same way as everywhere else.
    // Every other rule in the block above remains advisory.
    files: onboardingAdvisoryFiles,
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
    },
  },
  {
    // Test-double typing is idiomatic (mocks/fixtures routinely need `any`
    // and non-null assertions), and the sam/* runtime-boundary trio targets
    // production request/row-narrowing patterns that don't apply to test
    // setup. Keep all five rules non-blocking in test files while every
    // block above enforces `error` in production source, repo-wide
    // (including the onboarding-advisory workspaces). This block must stay
    // last so it wins over every earlier matching block. See
    // tasks/archive/2026-08-10-ai-slop-debt-burndown.md.
    files: testFileGlobs,
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      'sam/no-local-record-guard': 'off',
      'sam/no-unsafe-json-parse-assertion': 'off',
      'sam/no-unvalidated-request-json': 'off',
    },
  },
]);
