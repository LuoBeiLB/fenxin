/**
 * Jest 配置 — 单元测试（v4.0 性能与质量批次）
 *
 * 设计要点：
 *  - 用 ts-jest preset，TypeScript 与 nest-cli 同一 tsconfig
 *  - 模块路径映射 `src/*` → `<rootDir>/src/*`，spec 里直接 `import { xxx } from 'src/...'`
 *  - 单元测试不接 DB / Redis；E2E 走 `test/e2e/**.e2e-spec.ts` 另配（后续）
 *  - 覆盖率统计排除 module / main / index（无业务逻辑）
 *  - isolatedModules 已挪到 tsconfig.json（ts-jest 29.4+ 要求）
 */

/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '.',
  testMatch: ['<rootDir>/src/**/*.spec.ts', '<rootDir>/test/**/*.spec.ts'],
  testPathIgnorePatterns: ['/node_modules/', '/dist/', '/e2e/'],
  moduleNameMapper: {
    '^src/(.*)$': '<rootDir>/src/$1',
  },
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        tsconfig: 'tsconfig.json',
      },
    ],
  },
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.module.ts',
    '!src/main.ts',
    '!src/**/index.ts',
    '!src/**/*.dto.ts',
    '!src/**/*.entity.ts',
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov', 'html'],
  setupFiles: ['<rootDir>/test/jest.setup.ts'],
  silent: false,
  testTimeout: 10000,
};
