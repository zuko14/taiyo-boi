import { defineConfig } from '@playwright/test';

// E2E against the local stack. `npm run test:e2e` loads local Supabase env and reuses a running dev server.
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 180_000,
  fullyParallel: false,
  use: { baseURL: process.env.APP_URL ?? 'http://localhost:3000', trace: 'retain-on-failure' },
  webServer: { command: 'npx next dev', url: 'http://localhost:3000/login', reuseExistingServer: true, timeout: 120_000 },
});
