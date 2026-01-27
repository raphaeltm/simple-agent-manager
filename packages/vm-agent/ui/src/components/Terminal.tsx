import { useEffect, useRef, useCallback, useState } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';

interface TerminalProps {
  onReady?: () => void;
  onDisconnect?: () => void;
  token?: string;
}

interface WSMessage {
  type: string;
  data?: unknown;
}

export function Terminal({ onReady, onDisconnect, token }: TerminalProps) {
  const terminalRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const [connected, setConnected] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      return;
    }

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host;
    const term = xtermRef.current;

    if (!term) return;

    const rows = term.rows;
    const cols = term.cols;

    let wsUrl = `${protocol}//${host}/terminal/ws?rows=${rows}&cols=${cols}`;
    if (token) {
      wsUrl += `&token=${encodeURIComponent(token)}`;
    }

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
      term.writeln('\x1b[32mConnected to workspace terminal\x1b[0m');
      onReady?.();
    };

    ws.onmessage = (event) => {
      try {
        const msg: WSMessage = JSON.parse(event.data);

        switch (msg.type) {
          case 'output':
            if (msg.data && typeof msg.data === 'object' && 'data' in msg.data) {
              term.write((msg.data as { data: string }).data);
            }
            break;
          case 'session':
            if (msg.data && typeof msg.data === 'object' && 'sessionId' in msg.data) {
              setSessionId((msg.data as { sessionId: string }).sessionId);
            }
            break;
          case 'error':
            term.writeln(`\x1b[31mError: ${msg.data}\x1b[0m`);
            break;
          case 'pong':
            // Heartbeat response
            break;
        }
      } catch (e) {
        console.error('Failed to parse message:', e);
      }
    };

    ws.onclose = () => {
      setConnected(false);
      setSessionId(null);
      term.writeln('\x1b[31mDisconnected from terminal\x1b[0m');
      onDisconnect?.();
    };

    ws.onerror = (error) => {
      console.error('WebSocket error:', error);
      term.writeln('\x1b[31mConnection error\x1b[0m');
    };
  }, [token, onReady, onDisconnect]);

  const sendMessage = useCallback((type: string, data?: unknown) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type, data }));
    }
  }, []);

  const handleResize = useCallback(() => {
    const fitAddon = fitAddonRef.current;
    const term = xtermRef.current;

    if (fitAddon && term) {
      fitAddon.fit();
      if (connected && sessionId) {
        sendMessage('resize', { rows: term.rows, cols: term.cols });
      }
    }
  }, [connected, sessionId, sendMessage]);

  useEffect(() => {
    if (!terminalRef.current) return;

    // Create terminal
    const term = new XTerm({
      cursorBlink: true,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      fontSize: 14,
      theme: {
        background: '#1e1e1e',
        foreground: '#d4d4d4',
        cursor: '#d4d4d4',
        cursorAccent: '#1e1e1e',
        selectionBackground: '#264f78',
        black: '#1e1e1e',
        red: '#f44747',
        green: '#6a9955',
        yellow: '#dcdcaa',
        blue: '#569cd6',
        magenta: '#c586c0',
        cyan: '#4ec9b0',
        white: '#d4d4d4',
        brightBlack: '#808080',
        brightRed: '#f44747',
        brightGreen: '#6a9955',
        brightYellow: '#dcdcaa',
        brightBlue: '#569cd6',
        brightMagenta: '#c586c0',
        brightCyan: '#4ec9b0',
        brightWhite: '#ffffff',
      },
    });

    // Add addons
    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon();

    term.loadAddon(fitAddon);
    term.loadAddon(webLinksAddon);

    // Open terminal
    term.open(terminalRef.current);
    fitAddon.fit();

    xtermRef.current = term;
    fitAddonRef.current = fitAddon;

    // Handle input
    term.onData((data) => {
      sendMessage('input', { data });
    });

    // Handle resize
    const resizeObserver = new ResizeObserver(() => {
      handleResize();
    });
    resizeObserver.observe(terminalRef.current);

    // Connect
    connect();

    // Heartbeat
    const heartbeat = setInterval(() => {
      sendMessage('ping');
    }, 30000);

    return () => {
      clearInterval(heartbeat);
      resizeObserver.disconnect();
      wsRef.current?.close();
      term.dispose();
    };
  }, [connect, sendMessage, handleResize]);

  return (
    <div className="terminal-container" style={{ width: '100%', height: '100%' }}>
      <div
        ref={terminalRef}
        style={{
          width: '100%',
          height: '100%',
          backgroundColor: '#1e1e1e',
        }}
      />
    </div>
  );
}
