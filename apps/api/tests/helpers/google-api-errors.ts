/**
 * Google API error bodies in the shape Google returns them (`google.rpc.Status` with an
 * `ErrorInfo` detail), so tests build provider errors through the real `providerFetch` parser
 * rather than hand-constructing a `ProviderError`.
 */

/** The 403 Google returns when an API is turned off in the caller's project. */
export function googleServiceDisabledBody(service: string, projectNumber = '123456') {
  return {
    error: {
      code: 403,
      message: `Cloud Billing API has not been used in project ${projectNumber} before or it is disabled. Enable it by visiting https://console.developers.google.com/apis/api/${service}/overview?project=${projectNumber} then retry.`,
      status: 'PERMISSION_DENIED',
      details: [
        {
          '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
          reason: 'SERVICE_DISABLED',
          domain: 'googleapis.com',
          metadata: {
            service,
            consumer: `projects/${projectNumber}`,
            activationUrl: `https://console.developers.google.com/apis/api/${service}/overview?project=${projectNumber}`,
          },
        },
        {
          '@type': 'type.googleapis.com/google.rpc.Help',
          links: [
            {
              description: 'Google developers console API activation',
              url: 'https://console.developers.google.com',
            },
          ],
        },
      ],
    },
  };
}

/** The 403 Google returns when the access token was minted without the scope the API needs. */
export function googleScopeInsufficientBody(service: string) {
  return {
    error: {
      code: 403,
      message: 'Request had insufficient authentication scopes.',
      status: 'PERMISSION_DENIED',
      details: [
        {
          '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
          reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT',
          domain: 'googleapis.com',
          metadata: { service, method: 'google.cloud.billing.v1.CloudCatalog.ListSkus' },
        },
      ],
    },
  };
}

/** An IAM refusal for the caller's own project. */
export function googleIamPermissionDeniedBody(service: string) {
  return {
    error: {
      code: 403,
      message: 'Permission denied on resource project.',
      status: 'PERMISSION_DENIED',
      details: [
        {
          '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
          reason: 'IAM_PERMISSION_DENIED',
          domain: 'cloudbilling.googleapis.com',
          metadata: { service },
        },
      ],
    },
  };
}

/** A 403 with no structured detail at all. */
export function googleBare403Body() {
  return {
    error: {
      code: 403,
      message: 'The caller does not have permission',
      status: 'PERMISSION_DENIED',
    },
  };
}

export function googleErrorResponse(body: unknown, status = 403): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
