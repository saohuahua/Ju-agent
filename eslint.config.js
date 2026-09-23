import eslint from '@eslint/js'
import tseslint from 'typescript-eslint'

/**
 * 运行环境全局量
 *
 * 本仓不引入 globals 包 环境全局量在这里显式声明
 * 后端八包保持零新增依赖的纪律同样适用于工具链（ADR-012 只为 apps/web 开口）
 */
const NODE_GLOBALS = {
  console: 'readonly',
  process: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  URL: 'readonly',
  TextEncoder: 'readonly',
  TextDecoder: 'readonly',
}

/** 浏览器全局量 供注入页面上下文执行的脚本片段使用 */
const BROWSER_GLOBALS = {
  window: 'readonly',
  document: 'readonly',
  location: 'readonly',
  performance: 'readonly',
  requestAnimationFrame: 'readonly',
  PerformanceObserver: 'readonly',
}

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/coverage/**',
      // 会话级临时工作树 不属于仓库源码
      '.claude/worktrees/**',
      'apps/web/next-env.d.ts',
      'apps/web/.next/types/**',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts', '**/*.tsx'],
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      'no-console': 'off',
      'prefer-const': 'error',
      'no-throw-literal': 'error',
    },
  },
  {
    // Node 侧脚本与测试 运行在 Node 运行时
    files: [
      '**/*.mjs',
      'scripts/**/*.{js,ts}',
      '**/test/**/*.ts',
      'packages/**/src/**/*.ts',
      'apps/api/src/**/*.ts',
    ],
    languageOptions: { globals: NODE_GLOBALS },
  },
  {
    // 性能脚本把代码片段注入浏览器上下文执行 需同时具备两套全局量
    files: ['apps/web/scripts/**/*.mjs'],
    languageOptions: { globals: { ...NODE_GLOBALS, ...BROWSER_GLOBALS } },
  },
  {
    // 故障注入测试替身用「只抛不产出」的异步生成器模拟上游中断 是有意为之
    files: ['**/test/**/*.ts'],
    rules: { 'require-yield': 'off' },
  },
)
