import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // One shared Chromium per worker; keep files sequential to stay light on CI.
    fileParallelism: false,
  },
});
