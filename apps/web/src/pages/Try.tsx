/**
 * /try — Landing page for the zero-friction URL-to-workspace trial flow.
 *
 * Wave-0 stub: renders a minimal placeholder. Wave-1 (SSE + frontend track)
 * will build the repo-URL input form, POST /api/trial/create, and redirect
 * into TryDiscovery when the trial starts.
 */
export function Try() {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: '100vh',
        padding: '2rem',
        fontFamily: 'system-ui, sans-serif',
      }}
    >
      <div style={{ maxWidth: '32rem', textAlign: 'center' }}>
        <h1 style={{ fontSize: '1.5rem', marginBottom: '0.5rem' }}>
          Try SAM with any public GitHub repo
        </h1>
        <p style={{ opacity: 0.7 }}>
          Zero-friction trial onboarding is in development.
        </p>
      </div>
    </div>
  );
}
