package acp

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
)

const (
	defaultCodexNativeHandshakeTimeout    = 15 * time.Second
	defaultCodexNativeRequestTimeout      = 30 * time.Second
	defaultCodexNativeWebSocketBufferSize = 4096
)

type codexNativeEventHandler func(codexNativeEnvelope)

type codexNativeEnvelope struct {
	ID     json.RawMessage `json:"id,omitempty"`
	Method string          `json:"method,omitempty"`
	Params json.RawMessage `json:"params,omitempty"`
	Result json.RawMessage `json:"result,omitempty"`
	Error  *struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	} `json:"error,omitempty"`
}

type codexNativeClient struct {
	conn           *websocket.Conn
	transport      io.Closer
	handler        codexNativeEventHandler
	writeMu        sync.Mutex
	pendingMu      sync.Mutex
	pending        map[int64]chan codexNativeEnvelope
	nextID         atomic.Int64
	closed         chan struct{}
	closeOnce      sync.Once
	readErrMu      sync.Mutex
	readErr        error
	requestTimeout time.Duration
}

func connectCodexNativeClient(ctx context.Context, config codexSharedDaemonConfig, handler codexNativeEventHandler) (*codexNativeClient, error) {
	if err := validateCodexSharedDaemonEndpoint(ctx, config); err != nil {
		return nil, err
	}
	transport, err := startCodexNativeProxy(ctx, config)
	if err != nil {
		return nil, err
	}

	timerDone := make(chan struct{})
	timer := time.AfterFunc(config.handshakeTimeout, func() {
		_ = transport.Close()
		close(timerDone)
	})
	wsURL := &url.URL{Scheme: "ws", Host: "localhost", Path: "/"}
	conn, response, err := websocket.NewClient(transport, wsURL, http.Header{}, config.websocketBufferSize, config.websocketBufferSize)
	if !timer.Stop() {
		<-timerDone
		if conn != nil {
			_ = conn.Close()
		}
		return nil, fmt.Errorf("connect to Codex shared daemon websocket: handshake timeout")
	}
	if response != nil && response.Body != nil {
		_ = response.Body.Close()
	}
	if err != nil {
		_ = transport.Close()
		return nil, fmt.Errorf("connect to Codex shared daemon websocket: %w", err)
	}
	conn.SetReadLimit(config.maxMessageBytes)

	client := &codexNativeClient{
		conn:           conn,
		transport:      transport,
		handler:        handler,
		pending:        make(map[int64]chan codexNativeEnvelope),
		closed:         make(chan struct{}),
		requestTimeout: config.requestTimeout,
	}
	go client.readLoop()
	return client, nil
}

func (c *codexNativeClient) initialize(ctx context.Context) error {
	var response struct {
		UserAgent string `json:"userAgent"`
	}
	if err := c.call(ctx, "initialize", map[string]any{
		"clientInfo": map[string]string{
			"name":    "sam_shared_daemon_observer",
			"title":   "SAM Shared Daemon Observer",
			"version": codexSharedDaemonVersion,
		},
		"capabilities": map[string]any{"experimentalApi": true},
	}, &response); err != nil {
		return err
	}
	if !hasExactVersionToken(response.UserAgent, codexSharedDaemonVersion) {
		return fmt.Errorf("Codex app-server reported server version does not match the pinned version")
	}
	return c.notify("initialized", map[string]any{})
}

func hasExactVersionToken(identity, version string) bool {
	for _, token := range strings.FieldsFunc(identity, func(r rune) bool {
		switch r {
		case ' ', '\t', '\r', '\n', '/', '(', ')', ';':
			return true
		default:
			return false
		}
	}) {
		if token == version {
			return true
		}
	}
	return false
}

func (c *codexNativeClient) resumeThread(ctx context.Context, threadID string) error {
	var response struct {
		Thread struct {
			ID string `json:"id"`
		} `json:"thread"`
	}
	if err := c.call(ctx, "thread/resume", map[string]string{"threadId": threadID}, &response); err != nil {
		return err
	}
	if response.Thread.ID != threadID {
		return fmt.Errorf("Codex shared daemon resumed thread %q, want attributed thread %q", response.Thread.ID, threadID)
	}
	return nil
}

func (c *codexNativeClient) readThread(ctx context.Context, threadID string) (json.RawMessage, error) {
	var response struct {
		Thread json.RawMessage `json:"thread"`
	}
	if err := c.call(ctx, "thread/read", map[string]any{"threadId": threadID, "includeTurns": true}, &response); err != nil {
		return nil, err
	}
	return response.Thread, nil
}

func (c *codexNativeClient) interruptTurn(ctx context.Context, threadID, turnID string) error {
	return c.call(ctx, "turn/interrupt", map[string]string{"threadId": threadID, "turnId": turnID}, nil)
}

func (c *codexNativeClient) call(ctx context.Context, method string, params any, result any) error {
	requestCtx := ctx
	if _, hasDeadline := ctx.Deadline(); !hasDeadline {
		var cancel context.CancelFunc
		requestCtx, cancel = context.WithTimeout(ctx, c.requestTimeout)
		defer cancel()
	}
	id := c.nextID.Add(1)
	responseCh := make(chan codexNativeEnvelope, 1)
	c.pendingMu.Lock()
	c.pending[id] = responseCh
	c.pendingMu.Unlock()

	if err := c.write(requestCtx, map[string]any{"id": id, "method": method, "params": params}); err != nil {
		c.removePending(id)
		return err
	}

	select {
	case response := <-responseCh:
		if response.Error != nil {
			return fmt.Errorf("Codex app-server %s failed with code %d", method, response.Error.Code)
		}
		if result != nil && len(response.Result) > 0 {
			if err := json.Unmarshal(response.Result, result); err != nil {
				return fmt.Errorf("decode Codex app-server %s response: %w", method, err)
			}
		}
		return nil
	case <-requestCtx.Done():
		c.removePending(id)
		return requestCtx.Err()
	case <-c.closed:
		return c.connectionError()
	}
}

func (c *codexNativeClient) notify(method string, params any) error {
	ctx, cancel := context.WithTimeout(context.Background(), c.requestTimeout)
	defer cancel()
	return c.write(ctx, map[string]any{"method": method, "params": params})
}

func (c *codexNativeClient) write(ctx context.Context, message any) error {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	if deadline, ok := ctx.Deadline(); ok {
		if err := c.conn.SetWriteDeadline(deadline); err != nil {
			return fmt.Errorf("set Codex app-server write deadline: %w", err)
		}
		defer c.conn.SetWriteDeadline(time.Time{})
	}
	if err := c.conn.WriteJSON(message); err != nil {
		return fmt.Errorf("write Codex app-server message: %w", err)
	}
	return nil
}

func (c *codexNativeClient) readLoop() {
	for {
		_, payload, err := c.conn.ReadMessage()
		if err != nil {
			c.finish(err)
			return
		}
		var envelope codexNativeEnvelope
		if err := json.Unmarshal(payload, &envelope); err != nil {
			c.finish(fmt.Errorf("decode Codex app-server message: %w", err))
			return
		}
		if id, ok := numericJSONRPCID(envelope.ID); ok && envelope.Method == "" {
			c.pendingMu.Lock()
			responseCh := c.pending[id]
			delete(c.pending, id)
			c.pendingMu.Unlock()
			if responseCh != nil {
				responseCh <- envelope
			}
			continue
		}
		if envelope.Method != "" && c.handler != nil {
			c.handler(envelope)
		}
	}
}

func numericJSONRPCID(raw json.RawMessage) (int64, bool) {
	if len(raw) == 0 || string(raw) == "null" {
		return 0, false
	}
	id, err := strconv.ParseInt(strings.Trim(string(raw), `"`), 10, 64)
	return id, err == nil
}

func (c *codexNativeClient) removePending(id int64) {
	c.pendingMu.Lock()
	delete(c.pending, id)
	c.pendingMu.Unlock()
}

func (c *codexNativeClient) finish(err error) {
	c.closeOnce.Do(func() {
		c.readErrMu.Lock()
		c.readErr = err
		c.readErrMu.Unlock()
		close(c.closed)
		_ = c.transport.Close()
	})
}

func (c *codexNativeClient) connectionError() error {
	c.readErrMu.Lock()
	defer c.readErrMu.Unlock()
	if c.readErr != nil {
		return c.readErr
	}
	return errors.New("Codex shared daemon connection closed")
}

func (c *codexNativeClient) Done() <-chan struct{} { return c.closed }
func (c *codexNativeClient) Err() error            { return c.connectionError() }

func (c *codexNativeClient) Close() error {
	c.finish(net.ErrClosed)
	return c.conn.Close()
}

type codexProxyConn struct {
	stdin  io.WriteCloser
	stdout io.ReadCloser
	cmd    *exec.Cmd
	once   sync.Once
}

func startCodexNativeProxy(ctx context.Context, config codexSharedDaemonConfig) (*codexProxyConn, error) {
	args := []string{"app-server", "proxy"}
	if config.socketPath != "" {
		args = append(args, "--sock", config.socketPath)
	}
	var cmd *exec.Cmd
	if config.containerID == "" {
		command, err := resolveHostExecutable(config.cliPath, config.workDir)
		if err != nil {
			return nil, fmt.Errorf("resolve Codex CLI: %w", err)
		}
		cmd = exec.CommandContext(ctx, command, args...)
		cmd.Env = mergeProcessEnv(os.Environ(), proxyEnvironment(config.envVars))
		if config.workDir != "" {
			cmd.Dir = config.workDir
		}
	} else {
		dockerPath, err := resolveHostExecutable("docker", "")
		if err != nil {
			return nil, fmt.Errorf("resolve Docker CLI: %w", err)
		}
		dockerArgs := []string{"exec", "-i"}
		if config.containerUser != "" {
			dockerArgs = append(dockerArgs, "-u", config.containerUser)
		}
		if config.workDir != "" {
			dockerArgs = append(dockerArgs, "-w", config.workDir)
		}
		for _, envVar := range proxyEnvironment(config.envVars) {
			dockerArgs = append(dockerArgs, "-e", envVar)
		}
		dockerArgs = append(dockerArgs, config.containerID, config.cliPath)
		dockerArgs = append(dockerArgs, args...)
		cmd = exec.CommandContext(ctx, dockerPath, dockerArgs...)
	}
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		_ = stdin.Close()
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		_ = stdin.Close()
		_ = stdout.Close()
		return nil, fmt.Errorf("start Codex app-server proxy: %w", err)
	}
	return &codexProxyConn{stdin: stdin, stdout: stdout, cmd: cmd}, nil
}

func validateCodexSharedDaemonEndpoint(ctx context.Context, config codexSharedDaemonConfig) error {
	args := []string{"--validate"}
	var cmd *exec.Cmd
	if config.containerID == "" {
		command, err := resolveHostExecutable(config.bridgePath, config.workDir)
		if err != nil {
			return fmt.Errorf("resolve Codex shared-daemon bridge: %w", err)
		}
		cmd = exec.CommandContext(ctx, command, args...)
		cmd.Env = mergeProcessEnv(os.Environ(), sharedDaemonProcessEnvironment(config.envVars))
		cmd.Dir = config.workDir
	} else {
		dockerPath, err := resolveHostExecutable("docker", "")
		if err != nil {
			return fmt.Errorf("resolve Docker CLI: %w", err)
		}
		dockerArgs := []string{"exec"}
		if config.containerUser != "" {
			dockerArgs = append(dockerArgs, "-u", config.containerUser)
		}
		if config.workDir != "" {
			dockerArgs = append(dockerArgs, "-w", config.workDir)
		}
		for _, envVar := range sharedDaemonProcessEnvironment(config.envVars) {
			dockerArgs = append(dockerArgs, "-e", envVar)
		}
		dockerArgs = append(dockerArgs, config.containerID, config.bridgePath)
		dockerArgs = append(dockerArgs, args...)
		cmd = exec.CommandContext(ctx, dockerPath, dockerArgs...)
	}
	if output, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("validate Codex shared-daemon endpoint: %w: %s", err, redactAgentDiagnosticText(string(output)))
	}
	return nil
}

func resolveHostExecutable(command, workDir string) (string, error) {
	candidate := command
	if !filepath.IsAbs(candidate) && strings.ContainsRune(candidate, filepath.Separator) {
		candidate = filepath.Join(workDir, candidate)
		absoluteCandidate, err := filepath.Abs(candidate)
		if err != nil {
			return "", err
		}
		candidate = absoluteCandidate
	}
	path, err := exec.LookPath(candidate)
	if err != nil {
		return "", err
	}
	if !filepath.IsAbs(path) {
		path, err = filepath.Abs(path)
		if err != nil {
			return "", err
		}
	}
	return filepath.Clean(path), nil
}

func proxyEnvironment(envVars []string) []string {
	allowed := map[string]struct{}{
		"HOME": {}, "CODEX_HOME": {}, "XDG_RUNTIME_DIR": {},
	}
	result := make([]string, 0, len(allowed))
	for _, envVar := range envVars {
		key, _, ok := strings.Cut(envVar, "=")
		if _, keep := allowed[key]; ok && keep {
			result = append(result, envVar)
		}
	}
	return result
}

func sharedDaemonProcessEnvironment(envVars []string) []string {
	allowed := map[string]struct{}{
		"HOME": {}, "CODEX_HOME": {}, "XDG_RUNTIME_DIR": {},
		codexSharedDaemonCLIEnv: {}, codexSharedDaemonExpectedEnv: {},
		codexSharedDaemonSocketEnv: {}, codexSharedDaemonOwnerFileEnv: {},
	}
	result := make([]string, 0, len(allowed))
	for _, envVar := range envVars {
		key, _, ok := strings.Cut(envVar, "=")
		if _, keep := allowed[key]; ok && keep {
			result = append(result, envVar)
		}
	}
	return result
}

func (c *codexProxyConn) Read(p []byte) (int, error)  { return c.stdout.Read(p) }
func (c *codexProxyConn) Write(p []byte) (int, error) { return c.stdin.Write(p) }
func (c *codexProxyConn) LocalAddr() net.Addr         { return codexProxyAddr("stdio") }
func (c *codexProxyConn) RemoteAddr() net.Addr        { return codexProxyAddr("unix") }
func (c *codexProxyConn) SetDeadline(deadline time.Time) error {
	readErr := c.SetReadDeadline(deadline)
	writeErr := c.SetWriteDeadline(deadline)
	if readErr != nil {
		return readErr
	}
	return writeErr
}
func (c *codexProxyConn) SetReadDeadline(deadline time.Time) error {
	if setter, ok := c.stdout.(interface{ SetReadDeadline(time.Time) error }); ok {
		return setter.SetReadDeadline(deadline)
	}
	return nil
}
func (c *codexProxyConn) SetWriteDeadline(deadline time.Time) error {
	if setter, ok := c.stdin.(interface{ SetWriteDeadline(time.Time) error }); ok {
		return setter.SetWriteDeadline(deadline)
	}
	return nil
}
func (c *codexProxyConn) Close() error {
	c.once.Do(func() {
		_ = c.stdin.Close()
		_ = c.stdout.Close()
		if c.cmd.Process != nil {
			_ = c.cmd.Process.Kill()
		}
		_ = c.cmd.Wait()
	})
	return nil
}

type codexProxyAddr string

func (a codexProxyAddr) Network() string { return "codex-proxy" }
func (a codexProxyAddr) String() string  { return string(a) }
