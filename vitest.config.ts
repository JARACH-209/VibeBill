import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    // Scenario tests build real git repos and spawn the CLI; give them room.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
