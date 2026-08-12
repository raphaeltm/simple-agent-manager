const SAM_COOKIE_PREFIX = 'sam_';
const DEFAULT_VM_SESSION_COOKIE = 'vm_session';
const BETTER_AUTH_SESSION_COOKIES = new Set([
  'better-auth.session_token',
  '__secure-better-auth.session_token',
  '__host-better-auth.session_token',
]);

function isVmSessionCookieName(name: string, vmSessionCookieName: string): boolean {
  for (const baseName of new Set([DEFAULT_VM_SESSION_COOKIE, vmSessionCookieName.toLowerCase()])) {
    if (name === baseName) return true;
    if (name.startsWith(`${baseName}_`)) {
      const workspaceCookieSuffix = name.slice(baseName.length + 1);
      if (/^[0-9a-hjkmnp-tv-z]{26}$/.test(workspaceCookieSuffix)) return true;
    }
  }
  return false;
}

function isSamReservedCookieName(
  name: string,
  vmSessionCookieName = DEFAULT_VM_SESSION_COOKIE
): boolean {
  const normalized = name.trim().toLowerCase();
  return (
    normalized.startsWith(SAM_COOKIE_PREFIX) ||
    isVmSessionCookieName(normalized, vmSessionCookieName) ||
    BETTER_AUTH_SESSION_COOKIES.has(normalized)
  );
}

function readSetCookieHeaders(headers: Headers): string[] {
  const getSetCookie = (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;
  if (getSetCookie) return getSetCookie.call(headers);
  const value = headers.get('set-cookie');
  return value ? [value] : [];
}

function makeHostOnlySetCookie(value: string): string {
  return value
    .split(';')
    .filter((attribute, index) => index === 0 || !/^\s*domain\s*=/i.test(attribute))
    .join(';');
}

function sanitizeClearSiteData(headers: Headers): void {
  const value = headers.get('clear-site-data');
  if (!value) return;
  const safeDirectives = value
    .split(',')
    .map((directive) => directive.trim())
    .filter((directive) => {
      const normalized = directive.replace(/^"|"$/g, '').toLowerCase();
      return normalized !== 'cookies' && normalized !== '*';
    });
  if (safeDirectives.length === 0) headers.delete('clear-site-data');
  else headers.set('clear-site-data', safeDirectives.join(', '));
}

export function stripSamReservedRequestCookies(
  headers: Headers,
  vmSessionCookieName = DEFAULT_VM_SESSION_COOKIE
): void {
  const value = headers.get('cookie');
  if (!value) return;
  const applicationCookies = value
    .split(';')
    .map((cookie) => cookie.trim())
    .filter((cookie) => {
      const separator = cookie.indexOf('=');
      const name = separator === -1 ? cookie : cookie.slice(0, separator);
      return !isSamReservedCookieName(name, vmSessionCookieName);
    });
  if (applicationCookies.length === 0) headers.delete('cookie');
  else headers.set('cookie', applicationCookies.join('; '));
}

export function isTrustedWorkspaceWebSocketOrigin(
  origin: string | null,
  baseDomain: string
): boolean {
  if (!origin) return true;
  if (!baseDomain) return false;
  const normalizedBaseDomain = baseDomain.toLowerCase();
  return (
    origin === `https://app.${normalizedBaseDomain}` ||
    origin === `https://api.${normalizedBaseDomain}`
  );
}

export function isolatePreviewResponse(
  response: Response,
  vmSessionCookieName = DEFAULT_VM_SESSION_COOKIE
): Response {
  const headers = new Headers(response.headers);
  const setCookies = readSetCookieHeaders(response.headers);
  headers.delete('set-cookie');
  for (const setCookie of setCookies) {
    const separator = setCookie.indexOf('=');
    const name = (separator === -1 ? setCookie : setCookie.slice(0, separator)).trim();
    if (!isSamReservedCookieName(name, vmSessionCookieName)) {
      headers.append('set-cookie', makeHostOnlySetCookie(setCookie));
    }
  }
  sanitizeClearSiteData(headers);

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
    webSocket: response.webSocket,
  });
}
