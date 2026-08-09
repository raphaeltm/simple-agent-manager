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
const samAdvisoryRules = {
  'sam/no-local-record-guard': 'warn',
  'sam/no-unsafe-json-parse-assertion': 'warn',
  'sam/no-unvalidated-request-json': 'warn',
};

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
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-non-null-assertion': 'warn',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'simple-import-sort/exports': 'error',
      'simple-import-sort/imports': 'error',
      ...samAdvisoryRules,
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
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-non-null-assertion': 'warn',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'simple-import-sort/exports': 'error',
      'simple-import-sort/imports': 'error',
      ...samAdvisoryRules,
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
    files: [
      'apps/www/**/*.{ts,tsx,mts,cts,astro}',
      'apps/tail-worker/**/*.{ts,tsx,mts,cts}',
      'infra/**/*.{ts,tsx,mts,cts}',
      'packages/cloud-init/**/*.{ts,tsx,mts,cts}',
      'tools/og-image/**/*.{ts,tsx,mts,cts}',
    ],
    rules: onboardingAdvisoryRules,
  },
]);
