import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig(async () => {
  const migrations = await readD1Migrations('./migrations');
  return {
    plugins: [
      cloudflareTest({
        main: './src/index.ts',
        wrangler: { configPath: './wrangler.jsonc' },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            ENVIRONMENT: 'test',
            PUBLIC_BASE_URL: 'https://uploads.test',
            ACCESS_TEAM_DOMAIN: 'https://team.cloudflareaccess.com',
            ACCESS_AUD: 'test-aud',
            ADMIN_EMAILS: '',
            GOOGLE_CLIENT_ID: 'client-id.apps.googleusercontent.com',
            GOOGLE_CLIENT_SECRET: 'client-secret',
            // Test-only key (32 zero-ish bytes); never used outside tests.
            TOKEN_ENCRYPTION_KEY: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8',
          },
        },
      }),
    ],
    test: {
      setupFiles: ['./test/setup.ts'],
      include: ['test/**/*.test.ts'],
    },
  };
});
