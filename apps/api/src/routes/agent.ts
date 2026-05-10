import { Hono } from 'hono';

import type { Env } from '../env';

const agentRoutes = new Hono<{ Bindings: Env }>();

// Agent binary names by OS/arch
const VM_AGENT_BINARIES: Record<string, string> = {
  'linux-amd64': 'vm-agent-linux-amd64',
  'linux-arm64': 'vm-agent-linux-arm64',
  'darwin-amd64': 'vm-agent-darwin-amd64',
  'darwin-arm64': 'vm-agent-darwin-arm64',
};

const SAM_HARNESS_BINARIES: Record<string, string> = {
  'linux-amd64': 'sam-harness-linux-amd64',
  'linux-arm64': 'sam-harness-linux-arm64',
};

const AGENT_BINARY_MAPS: Record<string, Record<string, string>> = {
  'vm-agent': VM_AGENT_BINARIES,
  'sam-harness': SAM_HARNESS_BINARIES,
};

/**
 * GET /api/agent/download - Download a runtime agent binary.
 * Query params:
 *   - agent: vm-agent, sam-harness (default: vm-agent)
 *   - os: linux, darwin (default: linux)
 *   - arch: amd64, arm64 (default: amd64)
 */
agentRoutes.get('/download', async (c) => {
  const agent = c.req.query('agent') || 'vm-agent';
  const os = c.req.query('os') || 'linux';
  const arch = c.req.query('arch') || 'amd64';

  const binaryKey = `${os}-${arch}`;
  const binaryName = AGENT_BINARY_MAPS[agent]?.[binaryKey];

  if (!binaryName) {
    return c.json(
      { error: 'INVALID_PLATFORM', message: `Unsupported agent/platform: ${agent} ${os}-${arch}` },
      400
    );
  }

  // Check if we're using R2
  if (!c.env.R2) {
    return c.json(
      { error: 'NOT_CONFIGURED', message: 'Agent binary storage not configured' },
      503
    );
  }

  // Fetch binary from R2
  const object = await c.env.R2.get(`agents/${binaryName}`);

  if (!object) {
    return c.json(
      { error: 'NOT_FOUND', message: `Agent binary not found for ${os}-${arch}` },
      404
    );
  }

  // Return binary with appropriate headers
  return new Response(object.body, {
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${binaryName}"`,
      'Content-Length': object.size.toString(),
      'Cache-Control': 'public, max-age=3600', // Cache for 1 hour
    },
  });
});

/**
 * GET /api/agent/version - Get the current agent version.
 */
agentRoutes.get('/version', async (c) => {
  // Check if we're using R2
  if (!c.env.R2) {
    return c.json({ version: 'unknown', available: false });
  }

  // Get version metadata from R2
  const metadata = await c.env.R2.get('agents/version.json');

  if (!metadata) {
    return c.json({ version: 'unknown', available: false });
  }

  const versionInfo = await metadata.json() as { version: string; buildDate: string };
  return c.json({ ...versionInfo, available: true });
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
