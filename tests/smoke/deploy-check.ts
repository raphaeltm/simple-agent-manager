import type { APIRequestContext, APIResponse } from '@playwright/test';

/**
 * Header matched by the "SAM deploy checks" Cloudflare skip rule, which lets deploy workflows
 * through stricter zone protections. The workflow sets `DEPLOY_CHECK_HEADER_VALUE` from a GitHub
 * secret; without it nothing is added. Never log the value.
 */
export const DEPLOY_CHECK_HEADER = 'x-sam-deploy-check';

/** Headers carrying the secret, empty when it is not configured. */
export function deployCheckHeaders(): Record<string, string> {
  const value = process.env.DEPLOY_CHECK_HEADER_VALUE;
  return value ? { [DEPLOY_CHECK_HEADER]: value } : {};
}

/** Whether the header is configured, and so whether browser traffic is routed (see fixtures.ts). */
export function deployCheckConfigured(): boolean {
  return Boolean(process.env.DEPLOY_CHECK_HEADER_VALUE);
}

/** `message` with every occurrence of the secret removed. */
export function redactDeployCheck(message: string): string {
  const value = process.env.DEPLOY_CHECK_HEADER_VALUE;
  return value ? message.split(value).join('[deploy-check header]') : message;
}

type FetchOptions = NonNullable<Parameters<APIRequestContext['fetch']>[1]>;

/**
 * One direct API call to the deployment under test, carrying the header. Always use this, never
 * `request.get/post` with the header added by hand:
 * - redirects are not followed, so the header (and any body) is only sent to the URL given;
 * - a failed call rethrows without the secret. Playwright's error lists every request header in
 *   its call log, and the reporter prints it; the original error is not kept as a cause.
 */
export async function deployCheckFetch(
  request: APIRequestContext,
  url: string,
  options: FetchOptions = {}
): Promise<APIResponse> {
  try {
    return await request.fetch(url, {
      ...options,
      headers: { ...options.headers, ...deployCheckHeaders() },
      maxRedirects: 0,
    });
  } catch (error) {
    throw new Error(redactDeployCheck(error instanceof Error ? error.message : String(error)));
  }
}
