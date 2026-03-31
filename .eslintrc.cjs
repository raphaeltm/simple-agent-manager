/** @type {import('eslint').Linter.Config} */
module.exports = {
  root: true,
  env: {
    browser: true,
    es2022: true,
    node: true,
  },
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
  ],
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module',
  },
  plugins: ['@typescript-eslint'],
  ignorePatterns: ['dist', 'node_modules', 'coverage', '*.js', '*.cjs'],
  rules: {
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    '@typescript-eslint/no-explicit-any': 'warn',
  },
  overrides: [
    {
      // Enforce structured logger in the API worker — no raw console.* calls.
      // The logger itself (logger.ts) is the sole console gateway.
      files: ['apps/api/src/**/*.ts'],
      // logger.ts is the sole console gateway; test files live outside apps/api/src/ so they're not matched by the files glob
      excludedFiles: ['apps/api/src/lib/logger.ts'],
      rules: {
        'no-console': 'error',
      },
    },
    {
      files: ['*.tsx'],
      extends: [
        'plugin:react/recommended',
        'plugin:react-hooks/recommended',
      ],
      plugins: ['react', 'react-hooks'],
      settings: {
        react: {
          version: 'detect',
        },
      },
      rules: {
        'react/react-in-jsx-scope': 'off',
        'react/prop-types': 'off',
      },
    },
  ],
};
