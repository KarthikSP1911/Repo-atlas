import { defineConfig } from 'vitest/config';

// Decorators (`experimentalDecorators`) come from tsconfig.json; vitest 5 reads it via oxc.
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
