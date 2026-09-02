// @ts-check
import eslint from '@eslint/js';
import stylistic from '@stylistic/eslint-plugin';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import unicorn from 'eslint-plugin-unicorn';

export default tseslint.config(
  {
    ignores: ['eslint.config.mjs'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,

  // Settings mirror the former .prettierrc
  stylistic.configs.customize({
    arrowParens: false,
    braceStyle: '1tbs',
    commaDangle: 'only-multiline',
    indent: 2,
    quoteProps: 'as-needed',
    quotes: 'single',
    semi: true,
  }),
  {
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.jest,
      },
      sourceType: 'commonjs',
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    plugins: { unicorn },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-floating-promises': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-unsafe-enum-comparison': 'off',
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/no-non-null-assertion': 'warn',
      '@typescript-eslint/prefer-regexp-exec': 'warn',
      '@typescript-eslint/restrict-template-expressions': 'off',

      // arrowParens: "avoid" — never add parens for a single parameter
      '@stylistic/arrow-parens': ['error', 'as-needed', { requireForBlockBody: false }],
      // singleQuote: true — use double quotes to avoid escaping
      '@stylistic/quotes': ['error', 'single', { allowTemplateLiterals: 'always', avoidEscape: true }],
      // printWidth: 120
      'max-len': ['error', { code: 120, ignoreUrls: true, ignoreStrings: true, ignoreTemplateLiterals: true, ignoreRegExpLiterals: true }],
      'max-depth': ['error', 4],
      'logical-assignment-operators': ['warn', 'always', { enforceForIfStatements: true }],
      'no-nested-ternary': 'error',
      'no-void': ['warn', { allowAsStatement: true }],
      'unicorn/no-for-each': 'warn',
      'unicorn/prefer-at': 'warn',
      'unicorn/prefer-includes': 'warn',
      'unicorn/prefer-string-replace-all': 'warn',
      'max-params': ['error', 7],
      'max-lines-per-function': ['warn', { max: 15, skipBlankLines: true, skipComments: true }],
    },
  },
  {
    files: ['src/commands/*.command.ts', 'src/agents/*.agent.ts'],
    rules: {
      'max-lines-per-function': ['warn', { max: 20, skipBlankLines: true, skipComments: true }],
    },
  },
  {
    files: ['**/*.spec.ts', 'test/manual/**/*.ts'],
    rules: {
      '@typescript-eslint/no-base-to-string': 'off',
      '@typescript-eslint/no-floating-promises': 'off',
      '@typescript-eslint/no-require-imports': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      '@typescript-eslint/unbound-method': 'off',
      'max-lines-per-function': 'off',
      'max-params': 'off',
    },
  },
);
