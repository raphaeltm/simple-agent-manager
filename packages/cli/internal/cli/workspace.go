package cli

import (
	"context"
	"crypto/tls"
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

	// Extract base domain from workspace URL
	baseDomain, err := extractBaseDomain(workspace.URL)
	if err != nil {
		return fail(runtime.Stderr, fmt.Errorf("cannot determine base domain: %w", err))
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
	forwarders, err := startForwarders(ctx, runtime, client, workspaceID, baseDomain, ports)
	if err != nil {
		return fail(runtime.Stderr, err)
	}

	// Print forwarding table
	fmt.Fprintf(runtime.Stderr, "\nForwarding %d port(s) for workspace %s:\n", len(forwarders), workspaceID)
	for _, f := range forwarders {
		fmt.Fprintf(runtime.Stderr, "  localhost:%d -> %s\n", f.localPort, f.remoteURL)
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
	localPort int
	remoteURL string
	listener  net.Listener
}

func startForwarders(ctx context.Context, runtime Runtime, client APIClient, workspaceID string, baseDomain string, ports []int) ([]portForwarder, error) {
	// Phase 1: bind all listeners before launching any goroutines
	var forwarders []portForwarder
	for _, port := range ports {
		remoteURL := fmt.Sprintf("https://ws-%s--%d.%s", strings.ToLower(workspaceID), port, baseDomain)

		listener, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", port))
		if err != nil {
			for _, f := range forwarders {
				f.listener.Close()
			}
			return nil, fmt.Errorf("failed to listen on port %d: %w", port, err)
		}

		forwarders = append(forwarders, portForwarder{
			localPort: port,
			remoteURL: remoteURL,
			listener:  listener,
		})
	}

	// Phase 2: all listeners bound successfully, now launch goroutines
	for _, f := range forwarders {
		go acceptConnections(ctx, runtime, client, workspaceID, f.localPort, f.listener, f.remoteURL)
	}
	return forwarders, nil
}

func acceptConnections(ctx context.Context, runtime Runtime, client APIClient, workspaceID string, port int, listener net.Listener, remoteURL string) {
	// Token cache with refresh
	tc := &tokenCache{
		client:      client,
		workspaceID: workspaceID,
		port:        port,
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
			req.Host = target.Host

			// Authenticate directly with the port proxy. Browser flows use
			// port_token to bootstrap this cookie via a redirect; the CLI needs
			// localhost requests to proxy transparently without exposing that 302.
			token, tokenErr := tc.getToken(req.Context())
			if tokenErr != nil {
				fmt.Fprintf(runtime.Stderr, "  [%s] token error: %v\n", time.Now().Format("15:04:05"), tokenErr)
				return
			}
			req.AddCookie(&http.Cookie{Name: "sam_port_access", Value: token})
		},
		Transport: &http.Transport{
			TLSClientConfig: &tls.Config{MinVersion: tls.VersionTLS12},
		},
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, proxyErr error) {
			fmt.Fprintf(runtime.Stderr, "  [%s] proxy error for %s %s: %v\n",
				time.Now().Format("15:04:05"), r.Method, r.URL.Path, proxyErr)
			w.WriteHeader(http.StatusBadGateway)
		},
	}

	server := &http.Server{
		Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			fmt.Fprintf(runtime.Stderr, "  [%s] %s %s -> localhost:%d\n",
				time.Now().Format("15:04:05"), r.Method, r.URL.Path, port)
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
	client      APIClient
	workspaceID string
	port        int

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

	resp, err := tc.client.GetPortToken(ctx, tc.workspaceID, tc.port)
	if err != nil {
		return "", err
	}

	tc.mu.Lock()
	tc.token = resp.Token
	// Refresh 2 minutes before the 15-minute expiry
	tc.expiresAt = time.Now().Add(13 * time.Minute)
	tc.mu.Unlock()
	return tc.token, nil
}
