import { useState, useEffect, useCallback } from 'react';
import { Terminal } from './components/Terminal';
import { StatusBar } from './components/StatusBar';

interface AuthState {
  authenticated: boolean;
  loading: boolean;
  error: string | null;
}

interface HealthResponse {
  status: string;
  workspaceId: string;
  sessions: number;
  idle: string;
}

function App() {
  const [auth, setAuth] = useState<AuthState>({
    authenticated: false,
    loading: true,
    error: null,
  });
  const [connected, setConnected] = useState(false);
  const [workspaceId, setWorkspaceId] = useState<string | undefined>();
  const [idleWarning, setIdleWarning] = useState<number>(0);

  // Get token from URL params
  const urlParams = new URLSearchParams(window.location.search);
  const tokenFromUrl = urlParams.get('token');

  // Check session status
  const checkSession = useCallback(async () => {
    try {
      const response = await fetch('/auth/session', {
        credentials: 'include',
      });
      const data = await response.json();

      if (data.authenticated) {
        setAuth({ authenticated: true, loading: false, error: null });
      } else if (tokenFromUrl) {
        // Authenticate with token from URL
        await authenticateWithToken(tokenFromUrl);
      } else {
        setAuth({ authenticated: false, loading: false, error: 'Not authenticated' });
      }
    } catch (error) {
      console.error('Session check failed:', error);
      if (tokenFromUrl) {
        await authenticateWithToken(tokenFromUrl);
      } else {
        setAuth({ authenticated: false, loading: false, error: 'Session check failed' });
      }
    }
  }, [tokenFromUrl]);

  // Authenticate with JWT token
  const authenticateWithToken = async (token: string) => {
    try {
      const response = await fetch('/auth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
        credentials: 'include',
      });

      if (!response.ok) {
        const error = await response.json();
        setAuth({ authenticated: false, loading: false, error: error.error || 'Authentication failed' });
        return;
      }

      setAuth({ authenticated: true, loading: false, error: null });
      // Remove token from URL for security
      window.history.replaceState({}, '', window.location.pathname);
    } catch (error) {
      console.error('Token auth failed:', error);
      setAuth({ authenticated: false, loading: false, error: 'Authentication failed' });
    }
  };

  // Fetch health info for workspace ID
  const fetchHealth = useCallback(async () => {
    try {
      const response = await fetch('/health');
      const data: HealthResponse = await response.json();
      setWorkspaceId(data.workspaceId);

      // Parse idle time and calculate warning
      const idleMatch = data.idle.match(/(\d+)m/);
      if (idleMatch) {
        const idleMinutes = parseInt(idleMatch[1], 10);
        // Show warning if idle for more than 25 minutes (5 min before 30 min timeout)
        if (idleMinutes >= 25) {
          setIdleWarning((30 - idleMinutes) * 60);
        } else {
          setIdleWarning(0);
        }
      }
    } catch (error) {
      console.error('Health check failed:', error);
    }
  }, []);

  useEffect(() => {
    checkSession();
    fetchHealth();

    // Poll health every 30 seconds
    const healthInterval = setInterval(fetchHealth, 30000);
    return () => clearInterval(healthInterval);
  }, [checkSession, fetchHealth]);

  // Loading state
  if (auth.loading) {
    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100vh',
          backgroundColor: '#1e1e1e',
          color: '#d4d4d4',
          fontFamily: 'system-ui, -apple-system, sans-serif',
        }}
      >
        <div style={{ textAlign: 'center' }}>
          <div
            style={{
              width: '40px',
              height: '40px',
              border: '4px solid #3c3c3c',
              borderTopColor: '#007acc',
              borderRadius: '50%',
              animation: 'spin 1s linear infinite',
              margin: '0 auto 16px',
            }}
          />
          <p>Connecting to workspace...</p>
        </div>
        <style>{`
          @keyframes spin {
            to { transform: rotate(360deg); }
          }
        `}</style>
      </div>
    );
  }

  // Error state
  if (auth.error && !auth.authenticated) {
    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100vh',
          backgroundColor: '#1e1e1e',
          color: '#d4d4d4',
          fontFamily: 'system-ui, -apple-system, sans-serif',
        }}
      >
        <div style={{ textAlign: 'center', maxWidth: '400px', padding: '20px' }}>
          <div
            style={{
              width: '60px',
              height: '60px',
              backgroundColor: '#f44336',
              borderRadius: '50%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              margin: '0 auto 16px',
            }}
          >
            <svg width="30" height="30" viewBox="0 0 24 24" fill="white">
              <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
            </svg>
          </div>
          <h2 style={{ margin: '0 0 8px', fontSize: '20px' }}>Authentication Failed</h2>
          <p style={{ margin: '0 0 16px', opacity: 0.7 }}>{auth.error}</p>
          <p style={{ margin: 0, fontSize: '14px', opacity: 0.5 }}>
            Please use the control panel to generate a new terminal access link.
          </p>
        </div>
      </div>
    );
  }

  // Main terminal view
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100vh',
        backgroundColor: '#1e1e1e',
      }}
    >
      <StatusBar
        connected={connected}
        workspaceId={workspaceId}
        idleWarning={idleWarning}
      />
      <div style={{ flex: 1, overflow: 'hidden' }}>
        <Terminal
          onReady={() => setConnected(true)}
          onDisconnect={() => setConnected(false)}
        />
      </div>
    </div>
  );
}

export default App;
