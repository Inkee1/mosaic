import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './desktop/e2e',
  workers: 1,
  timeout: 60000,
  expect: { timeout: 12000 },
  outputDir: 'test-results-desktop',
  reporter: 'list',
});
