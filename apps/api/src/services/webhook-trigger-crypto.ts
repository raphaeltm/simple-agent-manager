const TOKEN_PREFIX = 'sam_wh_';
const TOKEN_BYTES = 32;
const TOKEN_VALUE_LENGTH = 43;
const TOKEN_PATTERN = new RegExp(`^${TOKEN_PREFIX}[A-Za-z0-9_-]{${TOKEN_VALUE_LENGTH}}$`);

type WebhookHashDomain = 'token' | 'idempotency' | 'request';

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

async function hmac(value: string, secret: string, domain: WebhookHashDomain): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const payload = new TextEncoder().encode(`sam:webhook:${domain}:v1\0${value}`);
  const signature = await crypto.subtle.sign('HMAC', key, payload);
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function isWebhookTokenFormat(token: string): boolean {
  return TOKEN_PATTERN.test(token);
}

export function generateWebhookToken(): string {
  const bytes = new Uint8Array(TOKEN_BYTES);
  crypto.getRandomValues(bytes);
  return `${TOKEN_PREFIX}${bytesToBase64Url(bytes)}`;
}

export async function hashWebhookToken(token: string, secret: string): Promise<string> {
  return hmac(token, secret, 'token');
}

export async function hashWebhookIdempotencyKey(key: string, secret: string): Promise<string> {
  return hmac(key, secret, 'idempotency');
}

export async function fingerprintWebhookRequest(body: string, secret: string): Promise<string> {
  return hmac(body, secret, 'request');
}

export function getWebhookTokenLastFour(token: string): string {
  return token.slice(-4);
}
