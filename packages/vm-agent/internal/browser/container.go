package browser

import (
	"fmt"
	"strings"
)

// buildNekoEnv generates environment variable flags for the Neko container.
func buildNekoEnv(resolution string, maxFPS int, enableAudio, tcpFallback bool) []string {
	env := []string{
		fmt.Sprintf("NEKO_SCREEN=%s@%d", resolution, maxFPS),
		// Disable Neko's built-in authentication — SAM handles auth at the proxy layer.
		"NEKO_PASSWORD=neko",
		"NEKO_PASSWORD_ADMIN=admin",
		// Bind to all interfaces so it's reachable from the Docker network.
		"NEKO_BIND=:8080",
	}

	if !enableAudio {
		env = append(env, "NEKO_AUDIO=false")
	}

	if tcpFallback {
		// Use TCP fallback for WebRTC — works through existing HTTP proxy.
		env = append(env, "NEKO_ICELITE=true")
	}

	return env
}

// buildDockerRunArgs constructs the full `docker run` argument list for the Neko container.
func buildDockerRunArgs(containerName, image, networkName string, nekoPort int, envVars []string) []string {
	args := []string{
		"run", "-d",
		"--name", containerName,
		"--network", networkName,
		"--shm-size=2g", // Chrome requires shared memory for rendering
		"--restart", "unless-stopped",
	}

	for _, e := range envVars {
		args = append(args, "-e", e)
	}

	// Expose the Neko HTTP port on the container (accessible via Docker network).
	// No host port mapping needed — SAM's port proxy routes traffic via bridge IP.
	args = append(args, image)

	return args
}

// buildViewportChromeFlags generates Chrome flags for mobile viewport emulation.
func buildViewportChromeFlags(width, height, dpr int, isTouch bool) []string {
	if width <= 0 || height <= 0 {
		return nil
	}

	flags := []string{
		fmt.Sprintf("--window-size=%d,%d", width, height),
	}

	if dpr > 1 {
		flags = append(flags, fmt.Sprintf("--force-device-scale-factor=%d", dpr))
	}

	if isTouch {
		flags = append(flags,
			"--enable-touch-events",
			"--touch-events=enabled",
		)
	}

	return flags
}

// trimOutput trims whitespace and newlines from Docker command output.
func trimOutput(b []byte) string {
	return strings.TrimSpace(string(b))
}
