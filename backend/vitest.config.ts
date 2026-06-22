import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Rate-limiter tests talk to a real Redis and share global module state
    // (the singleton ioredis client); run files serially to avoid cross-test
    // key races within the same time window.
    fileParallelism: false,
    hookTimeout: 20000,
    testTimeout: 20000,
  },
});
