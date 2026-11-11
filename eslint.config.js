import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist', 'node_modules', '.*/**', 'spikes/**/*.mjs', 'test-results', 'playwright-report'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  // Node scripts that drive a browser: page callbacks use browser globals, so `no-undef` cannot know them.
  { files: ['**/*.mjs'], rules: { 'no-undef': 'off' } },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
);
