import { defineConfig, devices } from '@playwright/test';

const isGroups = !!process.env.E2E_GROUPS;
const blossomHost = process.env.E2E_BLOSSOM_HOST;
const blossomPin = process.env.E2E_BLOSSOM_CERT_PIN;

// Server lifecycle managed by scripts/run-e2e.mjs (random free port).
const baseURL = process.env.BASE_URL || 'http://localhost:3000';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: 'list',

  ...(isGroups ? { timeout: 120_000 } : {}),

  use: {
    baseURL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    ...(isGroups ? { actionTimeout: 30_000 } : {}),
  },

  expect: {
    ...(isGroups ? { timeout: 30_000 } : {}),
  },

  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // Provide fake audio/video streams so getUserMedia succeeds in headless mode.
        // Required for call e2e tests; harmless for all others.
        launchOptions: {
          args: [
            '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
            ...(blossomHost && blossomPin ? [
              `--host-resolver-rules=MAP ${blossomHost} 127.0.0.1`,
              `--proxy-bypass-list=${blossomHost}`,
              `--ignore-certificate-errors-spki-list=${blossomPin}`,
            ] : []),
          ],
        },
      },
      // DM tests need the strfry relay just like groups tests, so they run in
      // the same "groups" mode and are excluded from the fast suite.
      ...(isGroups
        ? { testMatch: ['groups-*.spec.ts', 'dm-*.spec.ts'] }
        : { testIgnore: ['groups-*.spec.ts', 'dm-*.spec.ts'] }),
    },
  ],
});
