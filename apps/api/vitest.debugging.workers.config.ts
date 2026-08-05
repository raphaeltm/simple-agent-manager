import { generateKeyPairSync } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const primaryMigrations = await readD1Migrations(
  fileURLToPath(new URL('./src/db/migrations', import.meta.url))
);
const observabilityMigrations = await readD1Migrations(
  fileURLToPath(new URL('./src/db/migrations/observability', import.meta.url))
);

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: './tests/workers/support/debugging-test-worker-entry.ts',
      miniflare: {
        compatibilityDate: '2024-04-03',
        compatibilityFlags: ['nodejs_compat'],
        d1Databases: ['DATABASE', 'OBSERVABILITY_DATABASE'],
        kvNamespaces: ['KV'],
        r2Buckets: ['R2'],
        durableObjects: {
          DIAGNOSIS_RUNNER: { className: 'DiagnosisRunner', useSQLite: true },
        },
        outboundService: async (request) => {
          const url = new URL(request.url);
          if (
            request.method !== 'POST' ||
            url.origin !== 'https://gateway.ai.cloudflare.com' ||
            url.pathname !== '/v1/test-account/test-gateway/workers-ai/v1/chat/completions'
          ) {
            return new Response('Unexpected outbound request', { status: 502 });
          }
          await new Promise((resolve) => setTimeout(resolve, 1_000));
          return Response.json({
            choices: [{ message: { content: 'Summary\nDeferred diagnosis completion' } }],
            usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
          });
        },
        bindings: {
          BASE_DOMAIN: 'test.example.com',
          VERSION: '0.1.0-test',
          CF_ACCOUNT_ID: 'test-account',
          CF_API_TOKEN: 'test-cloudflare-token',
          AI_GATEWAY_ID: 'test-gateway',
          JWT_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
          JWT_PUBLIC_KEY: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
          ENCRYPTION_KEY: 'SK4ihJazAK3GIWUQcM6nZ1odR6KQHrqRAVSp6HdPxrg=',
          TEST_PRIMARY_MIGRATIONS: primaryMigrations,
          TEST_OBSERVABILITY_MIGRATIONS: observabilityMigrations,
        },
      },
    }),
  ],
  test: {
    globals: true,
    include: [
      'tests/workers/diagnosis-runner-do.test.ts',
      'tests/workers/diagnostic-incidents.test.ts',
    ],
  },
});
