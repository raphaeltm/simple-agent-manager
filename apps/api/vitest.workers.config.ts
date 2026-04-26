/**
 * Vitest configuration for Cloudflare Workers integration tests.
 *
 * Uses @cloudflare/vitest-pool-workers to run tests inside the workerd runtime
 * with real D1, KV, and Durable Object bindings via Miniflare.
 *
 * Note: We use direct miniflare options instead of wrangler.toml because
 * the [ai] binding is not supported in the local workerd runtime.
 *
 * Run: pnpm test:workers
 */
import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: './src/index.ts',
      miniflare: {
        // 2024-04-03+ required for DO RPC (calling methods directly on stubs)
        compatibilityDate: '2024-04-03',
        compatibilityFlags: ['nodejs_compat'],
        d1Databases: ['DATABASE'],
        kvNamespaces: ['KV'],
        r2Buckets: ['R2'],
        durableObjects: {
          PROJECT_DATA: {
            className: 'ProjectData',
            useSQLite: true,
          },
          ADMIN_LOGS: {
            className: 'AdminLogs',
          },
          TRIAL_COUNTER: {
            className: 'TrialCounter',
            useSQLite: true,
          },
          TRIAL_EVENT_BUS: {
            className: 'TrialEventBus',
          },
          TRIAL_ORCHESTRATOR: {
            className: 'TrialOrchestrator',
            useSQLite: true,
          },
          SAM_SESSION: {
            className: 'SamSession',
            useSQLite: true,
          },
        },
        bindings: {
          BASE_DOMAIN: 'test.example.com',
          VERSION: '0.1.0-test',
          JWT_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQCV93x2EyxEBk7u\npFMTLatfONe6gGOnr6XV2z9FsfAN+8nVtHNykTXb+MxUPR7rn8im7CIQLkjQRRca\nieyya6tpusK5x08Qo4L/SzXW+XsKjf81k9cBwm84N3VVKSzbexUtz4uJWKWi+1sC\nFKWoCR+DWgWvhPw3jg/rt32N/hTKbMjEbMx224VmV+Dka2qVFLiqKW46o9astLcq\ngX/orE/y9wivDPzMQTM3IfRUwJHlJu0WIb70oLyptbXXAOBmGFJMdbEvpWItRODf\ndiJ3Pw9ngW97Er4AIfT2Wx0KnUchG8BFA2nfgrxI8M396nM8uSs8ezDaoCgYoktm\nCcuIIOb1AgMBAAECggEACmF5v5CfMUxAfXtpdrvkD3DXWgUWIN7jO1T0YcYp6EXk\nGENn9GfB0yq7Nh+O+t9yG7/fscAKcUQ/D6q5dDZIxMZVQVffDLdM05Aot2tIjZf7\nsQE9UlVbrogEOrNhdAXmlue1cHnu6UO97nxwZRvQjx6Voysw7EWMq5PlgIU0ejiH\nYjE52VQNadxQhZ8DqphOahcOt20deZ41cwN1bKlY4DnLuahVfkIZ9tA66+IY5ob2\nTuAl1plxQfadUNkVOusMbLjjv4ol/aqxccyhxr3IA/kM3UYiFxNohKIEJFsUuzGt\nWZxdIquRaH+FQtnhCUypkURcdzLrUisTQVgjVm97lwKBgQDGxjDwUkaefCMbv3FH\nAyVIaA8oMXRpERawEHmcS+egzfkdC4yC50Eh4fgYuSihnIKMYuJ4kJInarmfeZFD\n8EZdMqHckSNpxQcgYCII42gaXh/BjjZ+lQYmDKXyApTyfHwP/vZ/nkZjaJrEEWIg\nf4i+iN3B7KtIlZ1LuRF99d6BfwKBgQDBJCY+lYGIUBui+p+bbHdv5bK7uVg7xBim\nHLdr+LUioHQeSc0Z5mCjGWRV40KSCWP4iZNCvLHKPX8a0z3kEkKErLpwLPlZSB8a\ngWmC4p1FIFhn2P8od6LtaWGbMg+palXm/uDw990depEF3j9dMmnoQvt9rtEJxhgF\nNeDCzYzpiwKBgQDCfp7YJ8lNve2kcvhmIZ/Tb26VR36+Z6gpcpVr56GnaKM+VlSQ\nqbLDcpYNqu8k4z2iHAe5LMy1oOosLwmCzpIrEyXp6mIaVl2YwjfLNqhgVIUCISMV\nTMANbwbY/Mm9Uy0ZgcK0MKxzDKGTA+deISwuM0G5RNh8V1joBRgmhfPIBQKBgHnE\nNrBiRaYRCzt3UsUEX1CWulaMBcq4WOnxVNqnlFteWZb25G4dxnNNgOp9Ou0jKnn5\nEnSSzmw41TeuUmjF8lX/KBOs5w+Y3rMxP7oa8Rgxykq+ji+PLZMMS1My/pjKx5m4\nu0xwmGELcv8GHWC+dfLOuAuG+Zd14pL2YtuuB9b9AoGAIeYQNLMHNyEK/Kh4Vsza\n9rzbR0oXLqIe3PJOKqxpA4gSBdXbsizc7bkhhTHPDTpUo30Pke5f03O/RoawLT63\nr3SA1x5MVCsiVcqybvqtMIyy1zc/oKSUyuYh44Sjpii7Q9DJlCeMupyA3TSVb0Qa\nO+hP/5ZHDz4epkJVLKvwE2Y=\n-----END PRIVATE KEY-----',
          JWT_PUBLIC_KEY: '-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAlfd8dhMsRAZO7qRTEy2r\nXzjXuoBjp6+l1ds/RbHwDfvJ1bRzcpE12/jMVD0e65/IpuwiEC5I0EUXGonssmur\nabrCucdPEKOC/0s11vl7Co3/NZPXAcJvODd1VSks23sVLc+LiVilovtbAhSlqAkf\ng1oFr4T8N44P67d9jf4UymzIxGzMdtuFZlfg5GtqlRS4qiluOqPWrLS3KoF/6KxP\n8vcIrwz8zEEzNyH0VMCR5SbtFiG+9KC8qbW11wDgZhhSTHWxL6ViLUTg33Yidz8P\nZ4FvexK+ACH09lsdCp1HIRvARQNp34K8SPDN/epzPLkrPHsw2qAoGKJLZgnLiCDm\n9QIDAQAB\n-----END PUBLIC KEY-----',
          MAX_NODES_PER_USER: '10',
          MAX_AGENT_SESSIONS_PER_WORKSPACE: '10',
          MAX_PROJECTS_PER_USER: '50',
          MAX_SESSIONS_PER_PROJECT: '1000',
          MAX_MESSAGES_PER_SESSION: '10000',
          MESSAGE_SIZE_THRESHOLD: '102400',
          ACTIVITY_RETENTION_DAYS: '90',
          SESSION_IDLE_TIMEOUT_MINUTES: '60',
          DO_SUMMARY_SYNC_DEBOUNCE_MS: '5000',
          NODE_HEARTBEAT_STALE_SECONDS: '180',
          TRIAL_CLAIM_TOKEN_SECRET: 'test-trial-secret-do-not-use-in-production',
          TRIAL_SSE_HEARTBEAT_MS: '60000',
          TRIAL_SSE_POLL_TIMEOUT_MS: '500',
          TRIAL_SSE_MAX_DURATION_MS: '5000',
        },
      },
    }),
  ],
  test: {
    globals: true,
    include: ['tests/workers/**/*.test.ts'],
  },
});
