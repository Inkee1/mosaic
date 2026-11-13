import { defineConfig } from '@playwright/test';
const port = Number(process.env.MOSAIC_TEST_UI_PORT || 4317);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid test server port');
const baseURL = `http://127.0.0.1:${port}`;
export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  timeout: 30000,
  expect: { timeout: 6000 },
  reporter: 'list',
  use: {
    locale: 'ko-KR',
    baseURL,
    channel: 'chrome',
    viewport: { width: 1600, height: 1000 },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: `node node_modules/vite/bin/vite.js --host 127.0.0.1 --port ${port} --strictPort`,
    url: baseURL,
    reuseExistingServer: !process.env.MOSAIC_TEST_UI_PORT && !process.env.CI,
    timeout: 30000,
  },
});
