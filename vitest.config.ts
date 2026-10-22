import { defineConfig } from 'vitest/config';

// Run maintained source tests once, regardless of previously compiled output.
export default defineConfig({
  test: { include: ['src/**/*.{test,spec}.{ts,tsx}'] },
});
