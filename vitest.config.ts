import { configDefaults, defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['packages/**/*.test.{ts,tsx}'],
    // Shared test helpers: typechecked with the tests, never a suite.
    exclude: [...configDefaults.exclude, 'packages/**/*.helpers.test.{ts,tsx}'],
    environment: 'node',
  },
});
