package deploy

import (
	"net/http"
	"time"

	"github.com/workspace/vm-agent/internal/config"
)

// EngineConfig holds the configuration for the deploy engine.
type EngineConfig struct {
	EnvironmentID           string
	NodeID                  string
	ControlPlaneURL         string
	CallbackToken           string
	ComposeCmd              string // e.g., "docker compose"
	ComposeProjectName      string
	CaddyfilePath           string
	CaddyReloadCmd          string
	CaddyRestartCmd         string
	ACMEEmail               string // Contact email for the ACME global options block (optional)
	ACMECA                  string // ACME CA directory URL override, e.g. LE staging (optional)
	CaddyReadyTimeout       time.Duration
	CaddyReadyInterval      time.Duration
	HealthTimeout           time.Duration
	HealthPollInterval      time.Duration
	HTTPClient              *http.Client
	ArtifactIdleTimeout     time.Duration
	PreflightCommandTimeout time.Duration
	ApplyProgress           ApplyProgressFunc
	DockerLogin             DockerLoginFunc // defaults to cache.DockerLogin if nil
	MountChecker            MountChecker    // defaults to RealMountChecker if nil
	VolumeMounter           VolumeMounter   // defaults to RealVolumeMounter if nil
}

// NewEngine creates a new deployment engine.
func NewEngine(disk *DiskState, verifier *Verifier, cfg EngineConfig) *Engine {
	if cfg.ComposeCmd == "" {
		cfg.ComposeCmd = "docker compose"
	}
	if cfg.ComposeProjectName == "" {
		cfg.ComposeProjectName = "sam-env-" + SafeEnvironmentFilePart(cfg.EnvironmentID)
	}
	if cfg.CaddyfilePath == "" {
		cfg.CaddyfilePath = "/etc/caddy/Caddyfile"
	}
	if cfg.CaddyReloadCmd == "" {
		cfg.CaddyReloadCmd = "caddy reload --config {config} --adapter caddyfile"
	}
	if cfg.CaddyRestartCmd == "" {
		cfg.CaddyRestartCmd = "systemctl restart caddy"
	}
	if cfg.CaddyReadyTimeout == 0 {
		cfg.CaddyReadyTimeout = 2 * time.Minute
	}
	if cfg.CaddyReadyInterval == 0 {
		cfg.CaddyReadyInterval = 2 * time.Second
	}
	if cfg.HealthTimeout == 0 {
		cfg.HealthTimeout = 5 * time.Minute
	}
	if cfg.HealthPollInterval == 0 {
		cfg.HealthPollInterval = 5 * time.Second
	}
	if cfg.HTTPClient == nil {
		cfg.HTTPClient = NewArtifactHTTPClient(ArtifactHTTPClientConfig{})
	}
	if cfg.ArtifactIdleTimeout == 0 {
		cfg.ArtifactIdleTimeout = config.DefaultDeployArtifactIdleTimeout
	}
	if cfg.PreflightCommandTimeout == 0 {
		cfg.PreflightCommandTimeout = config.DefaultDeployPreflightCommandTimeout
	}
	return &Engine{
		disk:          disk,
		verifier:      verifier,
		cfg:           cfg,
		callbackToken: cfg.CallbackToken,
	}
}
