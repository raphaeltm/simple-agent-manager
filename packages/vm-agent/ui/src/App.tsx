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
  nodeId: string;
  activeWorkspaces: number;
}

interface AgentInstructionResponse {
  id: string;
  version: string;
  requiredChecklistVersion: string;
}

function App() {
  const [auth, setAuth] = useState<AuthState>({
    authenticated: false,
    loading: true,
    error: null,
  });
  const [connected, setConnected] = useState(false);
  const [nodeId, setNodeId] = useState<string | undefined>();
  const [complianceContext, setComplianceContext] = useState<AgentInstructionResponse | null>(null);

  const urlParams = new URLSearchParams(window.location.search);
  const tokenFromUrl = urlParams.get('token');

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
      window.history.replaceState({}, '', window.location.pathname);
    } catch {
      setAuth({ authenticated: false, loading: false, error: 'Authentication failed' });
    }
  };

  const checkSession = useCallback(async () => {
    try {
      const response = await fetch('/auth/session', { credentials: 'include' });
      const data = await response.json();

      if (data.authenticated) {
        setAuth({ authenticated: true, loading: false, error: null });
      } else if (tokenFromUrl) {
        await authenticateWithToken(tokenFromUrl);
      } else {
        setAuth({ authenticated: false, loading: false, error: 'Not authenticated' });
      }
    } catch {
      if (tokenFromUrl) {
        await authenticateWithToken(tokenFromUrl);
      } else {
        setAuth({ authenticated: false, loading: false, error: 'Session check failed' });
      }
    }
  }, [tokenFromUrl]);

  const fetchHealth = useCallback(async () => {
    try {
      const response = await fetch('/health');
      const data: HealthResponse = await response.json();
      setNodeId(data.nodeId);
    } catch {
      // Ignore transient health failures.
    }
  }, []);

  const fetchComplianceContext = useCallback(async () => {
    try {
      const response = await fetch('/api/ui-governance/agent-instructions/active', {
        credentials: 'include',
      });
      if (!response.ok) {
        setComplianceContext(null);
        return;
      }
      const data = (await response.json()) as AgentInstructionResponse;
      setComplianceContext(data);
    } catch {
      setComplianceContext(null);
    }
  }, []);

  useEffect(() => {
    void checkSession();
    void fetchHealth();
    void fetchComplianceContext();

    const healthInterval = setInterval(() => {
      void fetchHealth();
    }, 30000);
    const complianceInterval = setInterval(() => {
      void fetchComplianceContext();
    }, 60000);

    return () => {
      clearInterval(healthInterval);
      clearInterval(complianceInterval);
    };
  }, [checkSession, fetchHealth, fetchComplianceContext]);

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
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    );
  }

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
          <h2 style={{ margin: '0 0 8px', fontSize: '20px' }}>Authentication Failed</h2>
          <p style={{ margin: '0 0 16px', opacity: 0.7 }}>{auth.error}</p>
          <p style={{ margin: 0, fontSize: '14px', opacity: 0.5 }}>
            Please use the control panel to generate a new terminal access link.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100vh',
        backgroundColor: '#1e1e1e',
      }}
    >
      {complianceContext && (
        <div
          style={{
            backgroundColor: '#13201d',
            color: '#e6f2ee',
            fontSize: '12px',
            padding: '6px 12px',
            borderBottom: '1px solid #29423b',
          }}
        >
          UI Compliance: instruction set {complianceContext.version} · checklist {complianceContext.requiredChecklistVersion}
        </div>
      )}
      <StatusBar connected={connected} nodeId={nodeId} />
      <div style={{ flex: 1, overflow: 'hidden' }}>
        <Terminal onReady={() => setConnected(true)} onDisconnect={() => setConnected(false)} />
      </div>
    </div>
  );
}

export default App;
