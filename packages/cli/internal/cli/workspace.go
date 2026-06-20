package cli

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

func runWorkspace(ctx context.Context, runtime Runtime, parsed parsedArgs, args []string) int {
	if len(args) < 2 {
		return fail(runtime.Stderr, errors.New("usage: sam workspace <workspaceId> <action>\nactions: forward, ports"))
	}
	workspaceID := args[0]
	action := args[1]
	rest := args[2:]

	switch action {
	case "forward":
		return runWorkspaceForward(ctx, runtime, parsed, workspaceID, rest)
	case "ports":
		return runWorkspacePorts(ctx, runtime, parsed, workspaceID)
	default:
		return fail(runtime.Stderr, fmt.Errorf("unknown workspace action: %s", action))
	}
}

func runWorkspacePorts(ctx context.Context, runtime Runtime, parsed parsedArgs, workspaceID string) int {
	client, err := authenticatedClient(ctx, runtime)
	if err != nil {
		return fail(runtime.Stderr, err)
	}
	ports, err := client.GetWorkspacePorts(ctx, workspaceID)
	if err != nil {
		return fail(runtime.Stderr, fmt.Errorf("failed to list ports: %w", err))
	}
	if len(ports.Ports) == 0 {
		return writeOrFail(runtime, parsed.Globals.JSON, "No ports detected", ports)
	}
	text := formatPortsList(ports)
	return writeOrFail(runtime, parsed.Globals.JSON, text, ports)
}

func formatPortsList(ports PortsResponse) string {
	var sb strings.Builder
	sb.WriteString("Detected ports:\n")
	for _, p := range ports.Ports {
		label := p.Label
		if label == "" {
			label = "unknown"
		}
		fmt.Fprintf(&sb, "  %d  %s  %s\n", p.Port, label, p.URL)
	}
	return strings.TrimRight(sb.String(), "\n")
}

func runWorkspaceForward(ctx context.Context, runtime Runtime, parsed parsedArgs, workspaceID string, _ []string) int {
	client, err := authenticatedClient(ctx, runtime)
	if err != nil {
		return fail(runtime.Stderr, err)
	}

	// Parse --port flags (repeatable)
	requestedPorts, err := parsePortFlags(parsed)
	if err != nil {
		return fail(runtime.Stderr, err)
	}

	// Verify workspace exists and is running
	workspace, err := client.GetWorkspace(ctx, workspaceID)
	if err != nil {
		return fail(runtime.Stderr, fmt.Errorf("failed to get workspace: %w", err))
	}
	if workspace.Status != "running" && workspace.Status != "recovery" {
		return fail(runtime.Stderr, fmt.Errorf("workspace is %s, not running", workspace.Status))
	}

	// Determine which ports to forward
	ports := requestedPorts
	if len(ports) == 0 {
		// Auto-detect ports from workspace
		portsResp, err := client.GetWorkspacePorts(ctx, workspaceID)
		if err != nil {
			return fail(runtime.Stderr, fmt.Errorf("failed to detect ports: %w", err))
		}
		for _, p := range portsResp.Ports {
			ports = append(ports, p.Port)
		}
		if len(ports) == 0 {
			return fail(runtime.Stderr, errors.New("no ports detected on workspace. Use --port to specify ports manually"))
		}
	}

	localHost, err := parseLocalHostFlag(parsed)
	if err != nil {
		return fail(runtime.Stderr, err)
	}
	localPort, err := parseLocalPortFlag(parsed, ports)
	if err != nil {
		return fail(runtime.Stderr, err)
	}

	// Set up signal handling for graceful shutdown
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	defer signal.Stop(sigCh)
	go func() {
		select {
		case <-sigCh:
			cancel()
		case <-ctx.Done():
		}
	}()

	// Start forwarding
	forwarders, err := startForwarders(ctx, runtime, client, workspaceID, localHost, localPort, ports)
	if err != nil {
		return fail(runtime.Stderr, err)
	}

	// Print forwarding table
	fmt.Fprintf(runtime.Stderr, "\nForwarding %d port(s) for workspace %s:\n", len(forwarders), workspaceID)
	for _, f := range forwarders {
		fmt.Fprintf(runtime.Stderr, "  http://%s:%d -> remote port %d\n", f.localHost, f.localPort, f.remotePort)
	}
	fmt.Fprintln(runtime.Stderr, "\nPress Ctrl+C to stop.")

	// Wait for shutdown
	<-ctx.Done()
	fmt.Fprintln(runtime.Stderr, "\nShutting down...")

	// server.Shutdown (triggered by ctx cancellation) handles listener close and request drain
	return 0
}

func parsePortFlags(parsed parsedArgs) ([]int, error) {
	raw := flagValues(parsed.MultiFlags, "port")
	var ports []int
	for _, s := range raw {
		p, err := strconv.Atoi(s)
		if err != nil || p < 1 || p > 65535 {
			return nil, fmt.Errorf("invalid port: %s (must be 1-65535)", s)
		}
		ports = append(ports, p)
	}
	return ports, nil
}

func parseLocalPortFlag(parsed parsedArgs, remotePorts []int) (int, error) {
	raw := flagValue(parsed.Flags, "local-port")
	if raw == "" {
		return 0, nil
	}
	if len(remotePorts) != 1 {
		return 0, errors.New("--local-port can only be used when forwarding exactly one --port")
	}
	port, err := strconv.Atoi(raw)
	if err != nil || port < 1 || port > 65535 {
		return 0, fmt.Errorf("invalid local port: %s (must be 1-65535)", raw)
	}
	return port, nil
}

func parseLocalHostFlag(parsed parsedArgs) (string, error) {
	raw := flagValue(parsed.Flags, "local-host")
	if raw == "" {
		return "localhost", nil
	}
	switch raw {
	case "localhost", "127.0.0.1":
		return raw, nil
	default:
		return "", fmt.Errorf("invalid local host: %s (must be localhost or 127.0.0.1)", raw)
	}
}

func extractBaseDomain(workspaceURL string) (string, error) {
	if workspaceURL == "" {
		return "", errors.New("workspace has no URL")
	}
	u, err := url.Parse(workspaceURL)
	if err != nil {
		return "", err
	}
	// URL is like https://ws-{id}.{baseDomain}
	// Strip the first label (ws-{id}) to get the base domain
	host := u.Hostname()
	dotIndex := strings.Index(host, ".")
	if dotIndex < 0 {
		return "", fmt.Errorf("unexpected workspace URL format: %s", workspaceURL)
	}
	return host[dotIndex+1:], nil
}

type portForwarder struct {
	localPort  int
	localHost  string
	remotePort int
	targetURL  string
	listener   net.Listener
}

func startForwarders(ctx context.Context, runtime Runtime, client APIClient, workspaceID string, localHost string, localPortOverride int, ports []int) ([]portForwarder, error) {
	// Phase 1: bind all listeners before launching any goroutines
	var forwarders []portForwarder
	for _, remotePort := range ports {
		localPort := remotePort
		if localPortOverride != 0 {
			localPort = localPortOverride
		}

		listener, err := net.Listen("tcp", fmt.Sprintf("%s:%d", localHost, localPort))
		if err != nil {
			for _, f := range forwarders {
				f.listener.Close()
			}
			return nil, fmt.Errorf("failed to listen on %s:%d: %w", localHost, localPort, err)
		}

		targetURL := strings.TrimRight(client.config.APIURL, "/") +
			fmt.Sprintf("/api/workspaces/%s/local-forward/%d", url.PathEscape(workspaceID), remotePort)
		forwarders = append(forwarders, portForwarder{
			localHost:  localHost,
			localPort:  localPort,
			remotePort: remotePort,
			targetURL:  targetURL,
			listener:   listener,
		})
	}

	// Phase 2: all listeners bound successfully, now launch goroutines
	for _, f := range forwarders {
		go acceptConnections(ctx, runtime, client, workspaceID, f.remotePort, f.localHost, f.localPort, f.listener, f.targetURL)
	}
	return forwarders, nil
}

func acceptConnections(ctx context.Context, runtime Runtime, client APIClient, workspaceID string, remotePort int, localHost string, localPort int, listener net.Listener, remoteURL string) {
	// Token cache with refresh
	tc := &tokenCache{
		client:         client,
		workspaceID:    workspaceID,
		remotePort:     remotePort,
		localAuthority: fmt.Sprintf("%s:%d", localHost, localPort),
	}

	target, err := url.Parse(remoteURL)
	if err != nil {
		fmt.Fprintf(runtime.Stderr, "  invalid remote URL %s: %v\n", remoteURL, err)
		return
	}

	proxy := &httputil.ReverseProxy{
		Director: func(req *http.Request) {
			req.URL.Scheme = target.Scheme
			req.URL.Host = target.Host
			req.URL.Path = singleJoiningSlash(target.Path, req.URL.Path)
			req.URL.RawPath = ""
			req.Host = target.Host

			stripProxyRequestHeaders(req.Header)
			token, tokenErr := tc.getToken(req.Context())
			if tokenErr != nil {
				fmt.Fprintf(runtime.Stderr, "  [%s] token error: %v\n", time.Now().Format("15:04:05"), tokenErr)
				return
			}
			req.Header.Set("X-SAM-Forward-Token", token)
			req.Header.Set("X-SAM-Local-Authority", tc.localAuthority)
		},
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, proxyErr error) {
			fmt.Fprintf(runtime.Stderr, "  [%s] proxy error for %s %s: %v\n",
				time.Now().Format("15:04:05"), r.Method, r.URL.Path, proxyErr)
			w.WriteHeader(http.StatusBadGateway)
		},
	}

	server := &http.Server{
		Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if !isAllowedLocalForwardHost(r.Host, localHost, localPort) {
				http.Error(w, "invalid Host for local forward listener", http.StatusBadRequest)
				return
			}
			if isWebSocketUpgrade(r) {
				http.Error(w, "WebSocket upgrades are not supported by CLI local forwarding yet", http.StatusNotImplemented)
				return
			}
			fmt.Fprintf(runtime.Stderr, "  [%s] %s %s -> localhost:%d\n",
				time.Now().Format("15:04:05"), r.Method, r.URL.Path, remotePort)
			proxy.ServeHTTP(w, r)
		}),
		ReadTimeout:  30 * time.Second,
		WriteTimeout: 120 * time.Second,
		IdleTimeout:  120 * time.Second,
	}

	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		server.Shutdown(shutdownCtx)
	}()

	_ = server.Serve(listener)
}

// tokenCache manages port access token refresh.
type tokenCache struct {
	client         APIClient
	workspaceID    string
	remotePort     int
	localAuthority string

	mu        sync.Mutex
	token     string
	expiresAt time.Time
}

// getToken returns a valid port access token, refreshing if needed.
// Tokens are refreshed 2 minutes before expiry (tokens last 15 minutes).
func (tc *tokenCache) getToken(ctx context.Context) (string, error) {
	tc.mu.Lock()
	if tc.token != "" && time.Now().Before(tc.expiresAt) {
		t := tc.token
		tc.mu.Unlock()
		return t, nil
	}
	tc.mu.Unlock()

	resp, err := tc.client.CreateLocalForwardSession(ctx, tc.workspaceID, LocalForwardSessionRequest{
		RemotePort:     tc.remotePort,
		Mode:           "http",
		LocalAuthority: tc.localAuthority,
	})
	if err != nil {
		return "", err
	}

	tc.mu.Lock()
	tc.token = resp.Token
	tc.expiresAt = localForwardRefreshTime(resp.ExpiresAt)
	tc.mu.Unlock()
	return tc.token, nil
}

func localForwardRefreshTime(expiresAt string) time.Time {
	parsed, err := time.Parse(time.RFC3339, expiresAt)
	if err != nil {
		return time.Now().Add(time.Minute)
	}
	refreshAt := parsed.Add(-1 * time.Minute)
	if refreshAt.Before(time.Now()) {
		return time.Now().Add(5 * time.Second)
	}
	return refreshAt
}

func isAllowedLocalForwardHost(host string, localHost string, localPort int) bool {
	if host == "" {
		return false
	}
	hostname, port, err := net.SplitHostPort(host)
	if err != nil {
		if strings.Contains(err.Error(), "missing port in address") {
			return false
		}
		return false
	}
	if port != strconv.Itoa(localPort) {
		return false
	}
	if hostname == localHost {
		return true
	}
	return (localHost == "localhost" && hostname == "127.0.0.1") ||
		(localHost == "127.0.0.1" && hostname == "localhost")
}

func singleJoiningSlash(a string, b string) string {
	aslash := strings.HasSuffix(a, "/")
	bslash := strings.HasPrefix(b, "/")
	switch {
	case aslash && bslash:
		return a + b[1:]
	case !aslash && !bslash:
		return a + "/" + b
	default:
		return a + b
	}
}

func stripProxyRequestHeaders(headers http.Header) {
	for name := range headers {
		lower := strings.ToLower(name)
		if strings.HasPrefix(lower, "x-sam-") ||
			strings.HasPrefix(lower, "x-forwarded-") ||
			lower == "forwarded" ||
			isHopByHopHeader(lower) {
			headers.Del(name)
		}
	}
}

func isHopByHopHeader(name string) bool {
	switch name {
	case "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade":
		return true
	default:
		return false
	}
}

func isWebSocketUpgrade(r *http.Request) bool {
	return strings.EqualFold(r.Header.Get("Upgrade"), "websocket")
}
