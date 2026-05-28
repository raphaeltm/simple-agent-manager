import { Hono } from 'hono';
import * as v from 'valibot';

import type { Env } from '../env';
import { registerBinaryArtifactRoutes } from './binary-artifacts';

const agentRoutes = new Hono<{ Bindings: Env }>();

const agentVersionSchema = v.object({
  version: v.string(),
  buildDate: v.string(),
});

registerBinaryArtifactRoutes(agentRoutes, {
  binaries: {
    'linux-amd64': 'vm-agent-linux-amd64',
    'linux-arm64': 'vm-agent-linux-arm64',
    'darwin-amd64': 'vm-agent-darwin-amd64',
    'darwin-arm64': 'vm-agent-darwin-arm64',
  },
  notConfiguredMessage: 'Agent binary storage not configured',
  notFoundLabel: 'Agent binary',
  storagePrefix: 'agents',
  unavailableVersion: { version: 'unknown', available: false },
  versionSchema: agentVersionSchema,
  versionValidationContext: 'agent.version_metadata',
});

/**
 * GET /api/agent/install-script - Get the install script for the VM agent.
 * This is used by cloud-init to download and install the agent on VMs.
 */
agentRoutes.get('/install-script', async (c) => {
  const controlPlaneUrl = c.req.header('host')
    ? `https://${c.req.header('host')}`
    : 'https://api.workspaces.example.com';

  const script = `#!/bin/bash
set -e

# Detect architecture
ARCH=$(uname -m)
case $ARCH in
  x86_64) ARCH="amd64" ;;
  aarch64) ARCH="arm64" ;;
  *) echo "Unsupported architecture: $ARCH"; exit 1 ;;
esac

# Detect OS
OS=$(uname -s | tr '[:upper:]' '[:lower:]')

echo "Downloading VM Agent for $OS-$ARCH..."

# Download agent binary
curl -fsSL "${controlPlaneUrl}/api/agent/download?os=$OS&arch=$ARCH" -o /usr/local/bin/vm-agent

# Make executable
chmod +x /usr/local/bin/vm-agent

echo "VM Agent installed successfully"

# Create systemd service
cat > /etc/systemd/system/vm-agent.service << 'EOF'
[Unit]
Description=Simple Agent Manager VM Agent
After=network.target

[Service]
Type=simple
ExecStart=/usr/local/bin/vm-agent
Restart=always
RestartSec=5
Environment=VM_AGENT_PORT=8443

[Install]
WantedBy=multi-user.target
EOF

# Enable and start service
systemctl daemon-reload
systemctl enable vm-agent
systemctl start vm-agent

echo "VM Agent service started"
`;

  return new Response(script, {
    headers: {
      'Content-Type': 'text/x-shellscript',
      'Content-Disposition': 'attachment; filename="install-vm-agent.sh"',
    },
  });
});

export { agentRoutes };
