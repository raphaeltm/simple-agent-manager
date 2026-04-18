/**
 * /try/:trialId — Discovery-mode view for a running trial.
 *
 * Wave-0 stub. Wave-1 (SSE + frontend track) will:
 *   - read :trialId from the URL
 *   - open an EventSource to /api/trial/:trialId/events
 *   - render trial.progress, trial.knowledge, trial.idea updates live
 *   - prompt the visitor to sign in with GitHub on trial.ready
 */
import { useParams } from 'react-router';

export function TryDiscovery() {
  const { trialId } = useParams<{ trialId: string }>();

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
      <div style={{ maxWidth: '40rem', textAlign: 'center' }}>
        <h1 style={{ fontSize: '1.5rem', marginBottom: '0.5rem' }}>
          Exploring your repo…
        </h1>
        <p style={{ opacity: 0.7, fontSize: '0.875rem' }}>
          Trial ID: <code>{trialId ?? 'unknown'}</code>
        </p>
        <p style={{ opacity: 0.6, marginTop: '1rem' }}>
          Live discovery updates will stream here.
        </p>
      </div>
    </div>
  );
}
