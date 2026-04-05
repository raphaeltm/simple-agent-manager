package browser

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"strings"
)

// generateRandomPassword creates a cryptographically random hex password.
func generateRandomPassword(byteLen int) (string, error) {
	buf := make([]byte, byteLen)
	if _, err := rand.Read(buf); err != nil {
		return "", fmt.Errorf("failed to generate random password: %w", err)
	}
	return hex.EncodeToString(buf), nil
}

// NekoEnvOptions holds all parameters for building Neko environment variables.
type NekoEnvOptions struct {
	Resolution    string
	MaxFPS        int
	NekoPort      int
	Password      string
	PasswordAdmin string
	EnableAudio   bool
	TCPFallback   bool
	NAT1TO1       string // Public IP for WebRTC NAT traversal
	MuxPort       int    // Single port for UDP/TCP multiplexing (0 = disabled)
}

// buildNekoEnv generates environment variable flags for the Neko container (legacy signature).
func buildNekoEnv(resolution string, maxFPS, nekoPort int, password, passwordAdmin string, enableAudio, tcpFallback bool) []string {
	return buildNekoEnvFromOpts(NekoEnvOptions{
		Resolution:    resolution,
		MaxFPS:        maxFPS,
		NekoPort:      nekoPort,
		Password:      password,
		PasswordAdmin: passwordAdmin,
		EnableAudio:   enableAudio,
		TCPFallback:   tcpFallback,
	})
}

// buildNekoEnvFromOpts generates environment variable flags for the Neko container.
func buildNekoEnvFromOpts(opts NekoEnvOptions) []string {
	env := []string{
		fmt.Sprintf("NEKO_SCREEN=%s@%d", opts.Resolution, opts.MaxFPS),
		// Neko passwords — per-container random credentials for defense-in-depth.
		// SAM handles auth at the proxy layer; these are set for Neko's internal requirements.
		fmt.Sprintf("NEKO_PASSWORD=%s", opts.Password),
		fmt.Sprintf("NEKO_PASSWORD_ADMIN=%s", opts.PasswordAdmin),
		// Bind to all interfaces on the configured port so it's reachable from the Docker network.
		fmt.Sprintf("NEKO_BIND=:%d", opts.NekoPort),
	}

	if !opts.EnableAudio {
		env = append(env, "NEKO_AUDIO=false")
	}

	if opts.TCPFallback {
		env = append(env, "NEKO_ICELITE=true")
	}

	// WebRTC NAT traversal: advertise the VM's public IP so browsers can reach
	// the Neko container for media streams (signaling goes through the HTTP proxy).
	if opts.NAT1TO1 != "" {
		env = append(env, fmt.Sprintf("NEKO_NAT1TO1=%s", opts.NAT1TO1))
	}

	// Multiplex all WebRTC UDP/TCP traffic on a single port for simpler firewall rules.
	if opts.MuxPort > 0 {
		env = append(env, fmt.Sprintf("NEKO_UDPMUX=%d", opts.MuxPort))
		env = append(env, fmt.Sprintf("NEKO_TCPMUX=%d", opts.MuxPort))
	}

	return env
}

// ResourceLimits configures Docker resource constraints for the Neko container.
type ResourceLimits struct {
	MemoryLimit string // e.g. "4g"
	CPULimit    string // e.g. "2"
	PidsLimit   int    // e.g. 512
}

// DockerRunOptions configures the docker run command for a Neko container.
type DockerRunOptions struct {
	ContainerName string
	Image         string
	NetworkName   string
	ShmSize       string
	NekoPort      int
	MuxPort       int // If > 0, expose this port on the host for WebRTC UDP/TCP mux
	EnvVars       []string
	Limits        ResourceLimits
}

// buildDockerRunArgs constructs the full `docker run` argument list for the Neko container.
func buildDockerRunArgs(containerName, image, networkName, shmSize string, nekoPort int, envVars []string, limits ResourceLimits) []string {
	return buildDockerRunArgsFromOpts(DockerRunOptions{
		ContainerName: containerName,
		Image:         image,
		NetworkName:   networkName,
		ShmSize:       shmSize,
		NekoPort:      nekoPort,
		EnvVars:       envVars,
		Limits:        limits,
	})
}

// buildDockerRunArgsFromOpts constructs the full `docker run` argument list for the Neko container.
func buildDockerRunArgsFromOpts(opts DockerRunOptions) []string {
	args := []string{
		"run", "-d",
		"--name", opts.ContainerName,
		"--network", opts.NetworkName,
		fmt.Sprintf("--shm-size=%s", opts.ShmSize), // Chrome requires shared memory for rendering
		"--restart", "no",                           // Manager controls lifecycle, not Docker daemon
		"--security-opt", "no-new-privileges",       // Prevent privilege escalation inside container
	}

	// Resource limits
	if opts.Limits.MemoryLimit != "" {
		args = append(args, "--memory", opts.Limits.MemoryLimit)
	}
	if opts.Limits.CPULimit != "" {
		args = append(args, "--cpus", opts.Limits.CPULimit)
	}
	if opts.Limits.PidsLimit > 0 {
		args = append(args, "--pids-limit", fmt.Sprintf("%d", opts.Limits.PidsLimit))
	}

	for _, e := range opts.EnvVars {
		args = append(args, "-e", e)
	}

	// Expose WebRTC mux port on the host for direct browser↔Neko media streams.
	// The HTTP proxy handles signaling (WebSocket); media needs direct UDP/TCP.
	if opts.MuxPort > 0 {
		args = append(args, "-p", fmt.Sprintf("%d:%d/udp", opts.MuxPort, opts.MuxPort))
		args = append(args, "-p", fmt.Sprintf("%d:%d/tcp", opts.MuxPort, opts.MuxPort))
	}

	args = append(args, opts.Image)

	return args
}

// trimOutput trims whitespace and newlines from Docker command output.
func trimOutput(b []byte) string {
	return strings.TrimSpace(string(b))
}
