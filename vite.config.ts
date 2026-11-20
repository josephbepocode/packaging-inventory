import { defineConfig } from 'vitest/config';

export default defineConfig({
  base: '/packaging-inventory/',
  build: { target: 'es2020' },
  test: { globals: true, environment: 'node' },
});
