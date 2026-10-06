import { copyCredentialLimitHeaders } from '../services/credential-limit-events';

function jsonErrorHeaders(headers?: HeadersInit): Headers {
  const responseHeaders = new Headers(headers);
  if (!responseHeaders.has('Content-Type')) responseHeaders.set('Content-Type', 'application/json');
  return responseHeaders;
}

export function credentialErrorHeaders(upstreamHeaders: Headers): Headers {
  const headers = jsonErrorHeaders();
  copyCredentialLimitHeaders(upstreamHeaders, headers);
  return headers;
}

export function anthropicError(
  message: string,
  type: string,
  status: number,
  headers?: HeadersInit
): Response {
  return new Response(JSON.stringify({ type: 'error', error: { type, message } }), {
    status,
    headers: jsonErrorHeaders(headers),
  });
}

export function openaiError(
  message: string,
  type: string,
  status: number,
  headers?: HeadersInit
): Response {
  return new Response(JSON.stringify({ error: { message, type } }), {
    status,
    headers: jsonErrorHeaders(headers),
  });
}

export function anthropicUsageGateError(
  reason: 'daily-token-budget' | 'monthly-cost-cap'
): Response {
  if (reason === 'daily-token-budget') {
    return anthropicError(
      'Daily token budget exceeded. Resets at midnight UTC.',
      'rate_limit_error',
      429
    );
  }

  return anthropicError(
    'Monthly cost cap exceeded. Adjust your cap in Settings > Usage.',
    'rate_limit_error',
    429
  );
}

export function openaiUsageGateError(reason: 'daily-token-budget' | 'monthly-cost-cap'): Response {
  if (reason === 'daily-token-budget') {
    return openaiError('Daily token budget exceeded.', 'rate_limit_error', 429);
  }

  return openaiError(
    'Monthly cost cap exceeded. Adjust your cap in Settings > Usage.',
    'rate_limit_error',
    429
  );
}
