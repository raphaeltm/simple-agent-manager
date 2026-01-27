# Getting Started with Cloud AI Workspaces

This guide will help you set up and run Cloud AI Workspaces locally for development.

## Prerequisites

- Node.js 22+
- pnpm 8+
- Docker (for local VM testing)

## Quick Start

### 1. Clone the Repository

```bash
git clone https://github.com/your-org/cloud-ai-workspaces.git
cd cloud-ai-workspaces
```

### 2. Install Dependencies

```bash
pnpm install
```

### 3. Set Up Environment Variables

Copy the example environment file and fill in your credentials:

```bash
cp .env.example .env
```

Edit `.env` with:

```bash
# Cloudflare configuration
CF_API_TOKEN=your-cloudflare-api-token
CF_ZONE_ID=your-zone-id
BASE_DOMAIN=vm.yourdomain.com

# Hetzner Cloud configuration
HETZNER_TOKEN=your-hetzner-api-token

# API authentication
API_TOKEN=your-secret-api-token
```

### 4. Build All Packages

```bash
pnpm build
```

### 5. Run Tests

```bash
pnpm test
```

### 6. Start Development Server

```bash
pnpm dev
```

This starts:
- API server at `http://localhost:8787`
- Web UI at `http://localhost:5173`

## Project Structure

```
cloud-ai-workspaces/
├── apps/
│   ├── api/          # Cloudflare Workers API
│   └── web/          # React web UI
├── packages/
│   ├── shared/       # Shared types and utilities
│   └── providers/    # Cloud provider implementations
├── scripts/
│   └── vm/           # VM setup scripts
└── docs/             # Documentation
```

## Creating Your First Workspace

1. Open the web UI at `http://localhost:5173`
2. Click "New Workspace"
3. Enter:
   - Repository URL: `https://github.com/your/repo`
   - Size: Medium (recommended)
4. Click "Create Workspace"

The workspace will be provisioned in 2-5 minutes. Once running:
1. Click "Open" to access the CloudCLI terminal
2. Run `claude login` to authenticate with your Claude Max subscription
3. Start using Claude Code!

## API Usage

### Create a Workspace

```bash
# Note: No Anthropic API key required - authenticate via 'claude login' after workspace is ready
curl -X POST http://localhost:8787/vms \
  -H "Authorization: Bearer your-api-token" \
  -H "Content-Type: application/json" \
  -d '{
    "repoUrl": "https://github.com/user/repo",
    "size": "medium"
  }'
```

### List Workspaces

```bash
curl http://localhost:8787/vms \
  -H "Authorization: Bearer your-api-token"
```

### Stop a Workspace

```bash
curl -X DELETE http://localhost:8787/vms/ws-abc123 \
  -H "Authorization: Bearer your-api-token"
```

## Deploying to Production

### Deploy API

```bash
cd apps/api
pnpm deploy
```

### Deploy Web

```bash
cd apps/web
pnpm deploy
```

## Troubleshooting

### Build Errors

Make sure to build packages in order:

```bash
pnpm --filter @cloud-ai-workspaces/shared build
pnpm --filter @cloud-ai-workspaces/providers build
pnpm --filter @cloud-ai-workspaces/api build
```

### DNS Issues

Check your Cloudflare zone ID and API token permissions. The token needs DNS edit permissions.

### VM Not Starting

Check the Hetzner Cloud console for server status. Common issues:
- Invalid SSH key
- Region capacity limits
- Account limits

## Next Steps

- Read the [Architecture Decision Records](../adr/) for design rationale
- Check the [API Contract](../../specs/001-mvp/contracts/api.md) for full API documentation
- Review [CONTRIBUTING.md](../../CONTRIBUTING.md) for contribution guidelines
