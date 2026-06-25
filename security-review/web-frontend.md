# Security Review: Domain E -- Web Frontend Security

**Date:** 2026-06-25
**Auditor:** Claude Opus 4.6 (automated, multi-agent)
**Scope:** `apps/web/` (React+Vite SPA), `apps/www/` (Astro marketing/docs), `packages/ui/`, `packages/terminal/`, `packages/acp-client/`
**Mode:** READ-ONLY audit. No code modifications.

## Delegation Evidence

Three SAM sub-subagents were dispatched via `dispatch_task` (profile `01KTS0KEQ3BETA4JE82X207792`, mission `c879abb0-770a-4187-8503-77dc1ba42ca8`):

| Task ID | Focus | Status |
|---------|-------|--------|
| `01KVZ8SBGJ70P6N9DRZYBRTJCS` | XSS / unsafe-render sweep | Failed (Hetzner 403: server limit) |
| `01KVZ8SQ3CMBG7QHYPJE35FEAT` | CSRF/CORS/CSP + cookie/token | Failed (Hetzner 403: server limit) |
| `01KVZ8T5H7F1B7KCWXG37KN8X5` | Secret-in-bundle + redirect/iframe | Failed (Hetzner 403: server limit) |

All SAM dispatches failed due to infrastructure limits. Three local background subagents were launched as backup (XSS deep audit, CORS/CSRF/CSP cookie audit, Secret/redirect/iframe audit). Findings below are synthesized from all sources.

## Summary

The web frontend exhibits strong security posture overall: the React SPA uses safe rendering patterns (no raw `innerHTML` in app code), BetterAuth cookie-based sessions are well-configured (`HttpOnly`, `Secure`, `SameSite=Lax`, `__Secure-` prefix), CORS is properly scoped with default-deny, and the `apps/www/` marketing site has a CSP meta tag. However, the **marketing site's mermaid rendering scripts inject unsanitized SVG via `innerHTML`** without DOMPurify -- a significant gap compared to the control plane which uses DOMPurify. The main SPA (`apps/web/`) has **no Content-Security-Policy** at all, session cookie material is leaked in JSON response bodies, and WebSocket authentication tokens are passed as URL query parameters.

## Severity Count

| Severity | Count |
|----------|-------|
| Critical | 2 |
| High | 2 |
| Medium | 4 |
| Low | 3 |
| Info | 3 |
| **Total** | **14** |

---

## Findings

### Critical

#### WEB-001: Mermaid SVG Injection Without Sanitization in docs-mermaid.ts

- **Severity:** Critical
- **CWE:** CWE-79 (Improper Neutralization of Input During Web Page Generation)
- **Location:** `apps/www/src/scripts/docs-mermaid.ts:34`
- **Description:** The documentation site's mermaid rendering script injects mermaid-generated SVG output directly via `container.innerHTML = svg` without any DOMPurify sanitization. Mermaid is initialized with only `theme: 'dark'` -- notably missing `securityLevel: 'strict'` (the default since mermaid v9 is `'strict'`, but explicit is safer). The error fallback at line 36 also injects `source` (from DOM `textContent`) unsanitized: `` container.innerHTML = `<pre style="color:#ffd1d1">${source}</pre>` ``.
- **Impact/Exploit:** If an attacker can contribute mermaid diagram content to the docs (via PR to the repo, CMS, or if docs content includes any user-controlled data), the SVG output could contain embedded `<script>` tags or event handlers (`onload`, `onerror`). Even without `securityLevel: 'loose'`, mermaid's SVG generation has had historical bypasses. The error fallback path is also injectable: `source` comes from DOM `textContent` which is safe from HTML injection by itself, but wrapping it in a template literal injected via `innerHTML` without escaping means any `<` or `>` characters in the source text would be parsed as HTML.
- **Evidence:**
  ```typescript
  // docs-mermaid.ts:34
  container.innerHTML = svg;
  // docs-mermaid.ts:36
  container.innerHTML = `<pre style="color:#ffd1d1">${source}</pre>`;
  ```
  Compare with the control plane (`packages/acp-client/src/components/MermaidDiagram.tsx:326`) which uses DOMPurify with a strict SVG sanitization config.
- **Remediation:** (1) Add DOMPurify sanitization before `innerHTML` assignment, reusing the `MERMAID_SVG_SANITIZE_CONFIG` pattern from `packages/acp-client/src/mermaid.ts`. (2) Explicitly set `securityLevel: 'strict'` in the mermaid `initialize()` call. (3) HTML-escape the `source` in the error fallback path.
- **Confidence:** High

#### WEB-002: Mermaid SVG Injection with securityLevel: 'loose' in blog-mermaid.ts

- **Severity:** Critical
- **CWE:** CWE-79 (Improper Neutralization of Input During Web Page Generation)
- **Location:** `apps/www/src/scripts/blog-mermaid.ts:46,415,431-434`
- **Description:** The blog mermaid rendering script explicitly sets `securityLevel: 'loose'` (line 46), which **enables inline HTML and click event handlers in mermaid diagrams**. Combined with unsanitized SVG injection (`canvas.innerHTML = svg` at line 415) and unsanitized error injection (`surface.innerHTML = ...${String(error)}...` at lines 431-434), this creates a direct XSS vector.
- **Impact/Exploit:** With `securityLevel: 'loose'`, mermaid explicitly allows `<script>` tags and event handlers in diagram definitions. An attacker who can author or inject blog content can execute arbitrary JavaScript in visitors' browsers. The error path also injects `String(error)` without escaping, which could contain attacker-controlled HTML if the error message includes user input.
- **Evidence:**
  ```typescript
  // blog-mermaid.ts:44-46
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'loose',
    // ...
  });
  // blog-mermaid.ts:415
  canvas.innerHTML = svg;
  // blog-mermaid.ts:431-434
  surface.innerHTML = `
    <div class="mermaid-error">
      <strong>Mermaid failed to render.</strong>
      <pre>${String(error)}</pre>
    </div>
  `;
  ```
- **Remediation:** (1) Change `securityLevel` to `'strict'`. (2) Add DOMPurify sanitization before all `innerHTML` assignments. (3) HTML-escape `String(error)` in the error fallback using `textContent` assignment instead.
- **Confidence:** High

---

### High

#### WEB-003: No Content-Security-Policy for Main SPA (apps/web/)

- **Severity:** High
- **CWE:** CWE-1021 (Improper Restriction of Rendered UI Layers), CWE-693 (Protection Mechanism Failure)
- **Location:** `apps/web/index.html` (entire file -- no CSP present)
- **Description:** The main SPA (`apps/web/`) has no Content-Security-Policy header or `<meta>` tag. No `_headers` file exists under `apps/web/public/`, and no Vite plugin injects CSP headers. The `apps/www/` marketing site has a CSP meta tag (line 48 of `Base.astro`), and the API sets CSP headers on file preview responses (`apps/api/src/routes/projects/files.ts:437`), but the primary authenticated application surface has zero CSP protection. No `X-Frame-Options` or `frame-ancestors` directive is set either, enabling clickjacking.
- **Impact/Exploit:** Without CSP, any XSS vulnerability (even via a third-party dependency) would have unrestricted access to execute arbitrary scripts, load external resources, exfiltrate data, and access cookies (mitigated by `HttpOnly` for session cookies, but not for other client-side state). The SPA handles sensitive operations including credential management, workspace control, and agent configuration. CSP would provide defense-in-depth against XSS exploitation. Without `frame-ancestors`, the app can be embedded in attacker-controlled iframes for clickjacking.
- **Evidence:**
  ```html
  <!-- apps/web/index.html -- no CSP meta tag -->
  <!DOCTYPE html>
  <html lang="en">
    <head>
      <meta charset="UTF-8" />
      <link rel="icon" type="image/png" href="/favicon.png" />
      <!-- ... no CSP ... -->
    </head>
  ```
  Compare with `apps/www/src/layouts/Base.astro:48` which has a comprehensive CSP.
- **Remediation:** Add a `_headers` file to `apps/web/public/` (Cloudflare Pages picks this up) or a CSP `<meta>` tag to `index.html`. Recommended policy: `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' wss://*.${BASE_DOMAIN} https://api.${BASE_DOMAIN}; img-src 'self' https: data:; frame-src 'self' https://*.${BASE_DOMAIN}; frame-ancestors 'none'; object-src 'none'; base-uri 'self'`. Also add `X-Frame-Options: DENY`. Start in report-only mode (`Content-Security-Policy-Report-Only`) and iterate.
- **Confidence:** High

#### WEB-004: Session Cookie Value Exposed in JSON Response Body

- **Severity:** High
- **CWE:** CWE-200 (Exposure of Sensitive Information), CWE-539 (Use of Persistent Cookies Containing Sensitive Information)
- **Location:** `apps/api/src/services/session-factory.ts:88-93`
- **Description:** The `buildSessionLoginResponse` function -- used by the API token login flow (`POST /api/auth/token-login`) and the device-flow login -- includes the full raw signed session cookie value in the JSON response body under the key `sessionCookie`. The value is the `__Secure-better-auth.session_token=<signed>` string, including the signed token material. This is intended for SAM CLI to extract and replay the cookie, but it completely defeats the `HttpOnly` protection on the `Set-Cookie` header: any JavaScript running on the page (XSS, browser extension, injected script) that can read the JSON response of the token-login call can exfiltrate the session cookie.
- **Impact/Exploit:** An XSS payload or malicious browser extension that intercepts the token-login response body obtains the full session cookie material, bypassing `HttpOnly`. This enables session hijacking from JavaScript despite the cookie being marked `HttpOnly`. The exposure window is during the login response -- not persistent, but any code that can read `fetch()` responses has access.
- **Evidence:**
  ```typescript
  // apps/api/src/services/session-factory.ts:89-100
  return new Response(
    JSON.stringify({
      success: true,
      user: { id: user.id, email: user.email, name: user.name },
      sessionCookie,   // <-- raw cookie value in body
    }),
    {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Set-Cookie': cookieHeader,  // HttpOnly is also set here
      },
    },
  );
  ```
- **Remediation:** Remove `sessionCookie` from the JSON response body for browser-facing flows. The CLI use-case should use the `Set-Cookie` header directly (curl and HTTP clients surface this) or receive a dedicated short-lived opaque bearer token instead of raw session cookie material.
- **Confidence:** High

---

### Medium

#### WEB-005: WebSocket Authentication Token in URL Query Parameter

- **Severity:** Medium
- **CWE:** CWE-598 (Use of GET Request Method With Sensitive Query Strings)
- **Location:** `apps/web/src/hooks/useProjectAgentSession.ts:145`, `apps/web/src/pages/workspace/useWorkspaceCore.ts:210`, `apps/api/src/index.ts:331`, `apps/api/src/routes/projects/files.ts:470`
- **Description:** WebSocket connections to the VM agent and file upload URLs pass authentication tokens as URL query parameters (`?token=...`). While WebSocket upgrade requests do not support custom headers (making query params the common workaround), tokens in URLs are logged by web servers, proxy servers, load balancers, and may appear in browser history or `Referer` headers. The port-access token flow correctly strips the token via a 302 redirect with `Referrer-Policy: no-referrer`, but the terminal/WebSocket token does not receive this treatment.
- **Impact/Exploit:** If the VM agent or any intermediate proxy (Cloudflare edge) logs the full WebSocket URL, the callback JWT token would be visible in log files. The token is scoped (callback JWT with limited permissions) and typically short-lived, which limits the blast radius. However, token leakage in logs is a persistent exposure.
- **Evidence:**
  ```typescript
  // useProjectAgentSession.ts:145
  const url = `${wsHost}/agent/ws?token=${encodeURIComponent(token)}${sessionQuery}`;
  // useWorkspaceCore.ts:210
  return `${wsProtocol}//${url.host}${wsPath}?token=${encodeURIComponent(token)}`;
  // files.ts:470
  const url = `${workspaceUrl}/workspaces/${encodeURIComponent(workspaceId)}/files/upload?token=${encodeURIComponent(token)}`;
  ```
- **Remediation:** Consider using the first message after WebSocket connection establishment to pass the token (connect unauthenticated, then send auth message). For file uploads, prefer an `Authorization: Bearer` header. Alternatively, ensure VM agent and proxy access logs redact query parameters, and that callback JWTs have short TTLs.
- **Confidence:** High

#### WEB-006: No Explicit CSRF Token Mechanism

- **Severity:** Medium
- **CWE:** CWE-352 (Cross-Site Request Forgery)
- **Location:** `apps/api/src/services/session-factory.ts:55-68`, `apps/web/src/lib/api/client.ts:26`
- **Description:** The application relies entirely on `SameSite=Lax` cookies for CSRF protection. There is no explicit CSRF token, double-submit cookie, or custom header requirement (e.g., `X-Requested-With`). All API calls use `credentials: 'include'` with cookie-based auth.
- **Impact/Exploit:** `SameSite=Lax` blocks cross-origin POST requests from navigations, but does not protect against:
  - Top-level form POST submissions from attacker-controlled pages (Lax allows some cross-site POST in specific browser implementations)
  - Subdomain attacks if any subdomain is compromised (cookies are scoped to `.${baseDomain}`)
  - Browser bugs in SameSite implementation

  The CORS configuration provides additional protection (origin validation with default-deny), but CORS and SameSite are independent layers that can each have bypasses.
- **Evidence:**
  ```typescript
  // session-factory.ts:55-68 - cookie config
  sameSite: 'lax',
  httpOnly: true,
  secure: !isLocalhost,
  // No CSRF token generation or validation

  // client.ts:26 - all requests include cookies
  credentials: 'include',
  ```
- **Remediation:** Add a custom header requirement (e.g., `X-SAM-Request: 1`) that the client sends on every request and the server validates. This is a lightweight CSRF defense that works well with SPA architectures and is complementary to SameSite. Alternatively, consider upgrading to `SameSite=Strict` (test OAuth callback flow first).
- **Confidence:** Medium (SameSite=Lax provides reasonable baseline protection for modern browsers)

#### WEB-007: Style Tag Allowed in Mermaid SVG DOMPurify Config

- **Severity:** Medium
- **CWE:** CWE-79 (Improper Neutralization of Input During Web Page Generation)
- **Location:** `packages/acp-client/src/mermaid.ts` (MERMAID_SVG_SANITIZE_CONFIG)
- **Description:** The DOMPurify config for mermaid SVG sanitization in the control plane includes `style` in `ALLOWED_TAGS` and `ADD_TAGS` includes `foreignObject`, `div`, `span`, `p`, `br`. While DOMPurify strips `<script>` tags, allowing `<style>` tags in sanitized SVG enables CSS injection attacks. The `foreignObject` allowance permits embedding arbitrary HTML elements inside SVG.
- **Impact/Exploit:** A `<style>` tag inside mermaid SVG could be used for:
  - CSS-based data exfiltration (attribute selectors + `background: url(...)`)
  - UI redressing / clickjacking via CSS positioning
  - Rendering misleading content over legitimate UI

  `foreignObject` + `div`/`span` allows HTML content inside SVG, which combined with `style` could overlay convincing phishing UI over the chat interface.
- **Evidence:**
  ```typescript
  // packages/acp-client/src/mermaid.ts
  ALLOWED_TAGS: ['svg', 'g', ..., 'style'],
  ADD_TAGS: ['foreignObject', 'div', 'span', 'p', 'br'],
  ALLOWED_ATTR: [..., 'href', 'xlink:href', 'style', ...],
  ```
- **Remediation:** Remove `style` from `ALLOWED_TAGS` -- mermaid styling can be achieved via inline `style` attributes (already allowed via `ALLOWED_ATTR`) which DOMPurify sanitizes more granularly. Consider tightening `foreignObject` allowance or adding `FORBID_TAGS: ['form', 'input', 'button']` to prevent interactive HTML inside SVG.
- **Confidence:** Medium

#### WEB-008: PDF File Preview Allows script-src 'unsafe-inline' on API Origin

- **Severity:** Medium
- **CWE:** CWE-79 (Improper Neutralization of Input During Web Page Generation)
- **Location:** `apps/api/src/routes/library.ts:344-346`
- **Description:** When serving PDF files from the library route, the API sets `Content-Security-Policy: default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; object-src 'self'`. If an attacker uploads a PDF containing embedded JavaScript (via JavaScript URIs in PDF annotations or form actions), the `unsafe-inline` policy permits that JavaScript to execute in the context of the API origin (`api.${BASE_DOMAIN}`), which also hosts authenticated endpoints. A successful XSS from a malicious PDF could make credentialed API calls as the viewing user.
- **Evidence:**
  ```typescript
  // apps/api/src/routes/library.ts:344-346
  'Content-Security-Policy': mimeTypeLower === 'application/pdf'
    ? "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; object-src 'self'"
    : "default-src 'none'; style-src 'unsafe-inline'",
  ```
- **Remediation:** Serve PDFs from a sandboxed origin separate from the API (R2 presigned URL, dedicated subdomain with no auth cookies). If PDF serving must remain on the API origin, tighten the CSP to remove `script-src 'unsafe-inline'` -- modern browsers render PDFs natively without inline script support. Consider adding `Content-Disposition: attachment` as a fallback to force download instead of inline rendering.
- **Confidence:** Medium (depends on browser PDF rendering behavior)

---

### Low

#### WEB-009: Prototype Route /sam Exposed Without Auth

- **Severity:** Low
- **CWE:** CWE-284 (Improper Access Control)
- **Location:** `apps/web/src/pages/SamPrototype.tsx`, route at `App.tsx:98-99`
- **Description:** The `/sam` route is publicly accessible without authentication. It connects to a real API endpoint (`/api/sam`) and renders agent responses using `SamMarkdown` (react-markdown with remarkGfm). While react-markdown is safe by default (no `dangerouslySetInnerHTML`), this is a live API surface exposed without auth gating.
- **Impact/Exploit:** An unauthenticated user can interact with the SAM agent chat prototype. If `/api/sam` requires auth server-side, this is a non-issue (API returns 401). If `/api/sam` does not require auth, it exposes platform AI resources to unauthenticated users. The markdown rendering is safe (react-markdown sanitizes by default).
- **Evidence:**
  ```tsx
  // App.tsx:98-99
  <Route path="/sam" element={<SamPrototype />} />
  // SamPrototype.tsx:36
  const chat = useAgentChat({ apiBase: '/api/sam' });
  ```
- **Remediation:** Verify `/api/sam` requires authentication server-side. If this is an intentional public demo, document the design decision. If not, move inside `<ProtectedLayout />`.
- **Confidence:** Medium (needs verification of server-side auth on `/api/sam`)

#### WEB-010: Test Harness Route Exposed in Production Bundle

- **Severity:** Low
- **CWE:** CWE-489 (Active Debug Code)
- **Location:** `apps/web/src/App.tsx:102`
- **Description:** A test harness route `/__test/trial-chat-gate` is registered as a public route in the main `App.tsx` router. This route is intended for Playwright audit harnesses but is included in the production bundle and accessible to any user.
- **Impact/Exploit:** Minimal direct security impact -- the harness mounts trial components with mock data. However, test routes in production expand the attack surface and may expose internal component behavior or mock data patterns.
- **Evidence:**
  ```tsx
  // App.tsx:102
  <Route path="/__test/trial-chat-gate" element={<TrialChatGateHarness />} />
  ```
- **Remediation:** Gate test harness routes behind an environment check (e.g., `import.meta.env.DEV`) so they are tree-shaken from production builds. Alternatively, use lazy imports so the component code is in a separate chunk that is only loaded when accessed.
- **Confidence:** High

#### WEB-011: No X-Frame-Options or frame-ancestors Directive on API HTML Responses

- **Severity:** Low
- **CWE:** CWE-1021 (Improper Restriction of Rendered UI Layers)
- **Location:** `apps/api/src/index.ts` (global middleware -- no X-Frame-Options set)
- **Description:** Neither the API Worker nor the Cloudflare Pages deployment for `apps/web/` sets `X-Frame-Options` or a `Content-Security-Policy: frame-ancestors` directive on HTML-producing endpoints. The application can be embedded in an `<iframe>` by any third-party page, enabling clickjacking attacks on authenticated actions. (This is related to WEB-003 but specifically affects the API Worker's HTML responses.)
- **Impact/Exploit:** An attacker can embed the authenticated SAM app in an invisible iframe and trick users into clicking on sensitive controls (credential management, workspace deletion, agent configuration) through UI redressing.
- **Evidence:** No `X-Frame-Options` header found in API Worker global middleware. No `_headers` file exists under `apps/web/public/`.
- **Remediation:** Add `X-Frame-Options: DENY` to the API Worker's global middleware and to a `_headers` file in `apps/web/public/`. The CSP `frame-ancestors 'none'` directive (recommended in WEB-003) would also address this.
- **Confidence:** High

---

### Informational

#### WEB-012: localStorage Used for Non-Sensitive UI Preferences Only

- **Severity:** Info
- **CWE:** N/A
- **Location:** Multiple hooks: `useTrialDraft.ts`, `useTabOrder.ts`, `ThemeContext.tsx`, `OnboardingContext.tsx`, `useLibraryIndex.ts`, `analytics.ts`
- **Description:** `localStorage` is used exclusively for UI preferences (theme, tab order, onboarding dismissal, chat drafts) and a non-auth analytics visitor ID. No authentication tokens, API keys, or sensitive data is stored in `localStorage` or `sessionStorage`. Session management is handled via `HttpOnly` cookies.
- **Impact/Exploit:** None. This is good practice.
- **Evidence:** Grep for `localStorage|sessionStorage` shows only UI preference and analytics storage.
- **Remediation:** None required.
- **Confidence:** High

#### WEB-013: VITE_ Environment Variables Contain Only Configuration

- **Severity:** Info
- **CWE:** N/A
- **Location:** `apps/web/.env.example`
- **Description:** All `VITE_*` environment variables (which are embedded in the client bundle by Vite) are configuration values -- URLs, feature flags, domain names. No secrets, API keys, or sensitive tokens are exposed via `VITE_*` variables.
- **Impact/Exploit:** None. This is good practice.
- **Evidence:**
  ```
  VITE_API_URL, VITE_BASE_DOMAIN, VITE_WS_PROTOCOL, VITE_PUBLIC_WEBSITE_URL, etc.
  ```
- **Remediation:** None required. Continue ensuring no secrets are added as `VITE_*` variables.
- **Confidence:** High

#### WEB-014: File Preview iframe Uses Restrictive Sandbox

- **Severity:** Info
- **CWE:** N/A
- **Location:** `apps/web/src/components/library/FilePreviewModal.tsx:280-283`
- **Description:** The file preview modal's iframe uses `sandbox="allow-same-origin"` without `allow-scripts`, preventing script execution in previewed content. SVG files are explicitly excluded from inline preview (`file-utils.ts:6`), and the API sets `Content-Security-Policy: "default-src 'none'; style-src 'unsafe-inline'"` on SVG responses (`files.ts:437`).
- **Impact/Exploit:** None. Defense-in-depth is well-implemented for file preview.
- **Evidence:**
  ```tsx
  <iframe sandbox="allow-same-origin" src={previewUrl} ... />
  ```
- **Remediation:** None required.
- **Confidence:** High

---

## Positive Security Observations

The following security practices were observed and merit recognition:

1. **No `dangerouslySetInnerHTML` in app code** -- the only usage in the SPA is `MarkdownRenderer.tsx:72` which applies DOMPurify sanitization first. The `acp-client` MermaidDiagram component also sanitizes.
2. **react-markdown with safe defaults** -- all markdown rendering (MessageBubble, SamMarkdown, chat) uses react-markdown which escapes HTML by default. No `rehype-raw` plugin that would allow raw HTML pass-through.
3. **URL sanitization** -- `apps/web/src/lib/url-utils.ts` sanitizes URLs to allowlist only `http:` and `https:` protocols. The `isFilePathHref()` function in MessageBubble explicitly blocks `javascript:`, `data:`, and `blob:` protocols.
4. **CORS default-deny** -- the API CORS configuration (`apps/api/src/index.ts:496-522`) uses proper subdomain checking with `new URL()` parsing (`hostname === baseDomain || hostname.endsWith(\`.${baseDomain}\`)`) and `return null` as the default for unrecognized origins. Separate `/mcp/*` CORS uses `origin: '*'` with `credentials: false`.
5. **Cookie security** -- session cookies use `__Secure-` prefix, `HttpOnly`, `Secure`, `SameSite=Lax`, and `Domain=.${baseDomain}` scoping. Port-access cookies correctly use `SameSite=Strict`.
6. **Open redirect protection** -- `Landing.tsx:29-33` validates redirect paths with `startsWith('/') && !startsWith('//')` and falls back to `/dashboard`. OAuth callbacks use hardcoded `callbackURL` paths.
7. **No `postMessage` usage** -- no `postMessage` or `addEventListener('message')` handlers found in `apps/web/src/`, eliminating an entire class of cross-origin messaging vulnerabilities.
8. **No `eval()` or `new Function()`** -- no dynamic code execution patterns found in the SPA codebase.
9. **Image `<img>` tag for image rendering** -- ImageViewer uses `<img src>` which prevents SVG script execution (browsers block scripts in `<img>` elements).
10. **Marketing site CSP** -- `apps/www/` has a comprehensive CSP meta tag: `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' https:; connect-src 'self' ${apiUrl}; frame-src 'none'; object-src 'none'; base-uri 'self'`.

---

## Methodology

- Static analysis of all files in `apps/web/`, `apps/www/`, `packages/ui/`, `packages/terminal/`, `packages/acp-client/`
- Grep-based sweeps for: `dangerouslySetInnerHTML`, `innerHTML`, `outerHTML`, `eval`, `Function(`, `postMessage`, `addEventListener.*message`, `localStorage`, `sessionStorage`, `document.cookie`, `VITE_`, `sandbox`, `iframe`, `Content-Security-Policy`, `X-Frame-Options`, `SameSite`, `HttpOnly`, `credentials`, `cors`, `origin`, `href`, `javascript:`, `data:`, `securityLevel`
- Manual code review of all markdown rendering paths, auth flows, CORS configuration, cookie settings, redirect handling, mermaid rendering, and file preview pipelines
- Three SAM sub-subagents dispatched (all failed due to infrastructure limits); three local background subagents launched as backup covering XSS, CORS/CSRF/CSP, and secret/redirect/iframe audit areas
- Cross-reference between control plane (apps/web/) and marketing site (apps/www/) security patterns to identify gaps
- API-side review of session-factory, trial cookies, file serving CSP, and CORS middleware for findings that impact the frontend security posture
