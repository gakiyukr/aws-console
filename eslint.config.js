import antfu from '@antfu/eslint-config'
import withNuxt from './.nuxt/eslint.config.mjs'

export default withNuxt(antfu(
  {
    ignores: ['.zcode/**'],
    rules: {
      // Allow trailing space in comments, for possible JSDoc formattings
      'style/no-trailing-spaces': ['error', { ignoreComments: true }],
      // Relaxes inline statements a bit
      'style/max-statements-per-line': ['error', { max: 2 }],
    },
  },
  // Allow trailing space for markdown formatting
  {
    files: ['**/*.md'],
    rules: {
      'style/no-trailing-spaces': 'off',
    },
  },
  // 兩個來源專案採用分號與雙引號；保留移植核心的原始格式，
  // 並持續套用會影響執行正確性的通用 ESLint 規則。
  {
    files: [
      'nuxt.config.ts',
      'scripts/**/*.mjs',
      'server/**/*.{js,ts}',
      'test/**/*.{js,mjs}',
    ],
    rules: {
      'antfu/consistent-chaining': 'off',
      'jsdoc/require-property-description': 'off',
      'jsdoc/require-returns-description': 'off',
      'node/prefer-global/buffer': 'off',
      'node/prefer-global/process': 'off',
      'perfectionist/sort-imports': 'off',
      'perfectionist/sort-named-imports': 'off',
      'regexp/no-unused-capturing-group': 'off',
      'regexp/no-useless-quantifier': 'off',
      'regexp/optimal-quantifier-concatenation': 'off',
      'regexp/prefer-d': 'off',
      'regexp/use-ignore-case': 'off',
      'style/arrow-parens': 'off',
      'style/brace-style': 'off',
      'style/comma-dangle': 'off',
      'style/no-multiple-empty-lines': 'off',
      'style/operator-linebreak': 'off',
      'style/quote-props': 'off',
      'style/quotes': 'off',
      'style/semi': 'off',
      'test/no-import-node-test': 'off',
    },
  },
))
