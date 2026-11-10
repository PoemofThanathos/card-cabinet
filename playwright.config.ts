import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 45000,
  use: { baseURL: 'http://127.0.0.1:4173/card-cabinet/', trace: 'retain-on-failure' },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'webkit', use: { ...devices['iPhone 13'] } },
  ],
  webServer: {
    command: 'npm run preview -- --port 4173 --base /card-cabinet/',
    url: 'http://127.0.0.1:4173/card-cabinet/',
    reuseExistingServer: false,
  },
});
