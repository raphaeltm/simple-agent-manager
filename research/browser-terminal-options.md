# Browser Terminal Architecture - Comprehensive Design

> **HISTORICAL DOCUMENT**: This research from January 2025 informed the terminal architecture decision. The terminal solution has been decided and implemented as a custom Go VM Agent with embedded xterm.js UI, JWT authentication, and WebSocket protocol. See `packages/vm-agent/` for the implementation.

**Date**: 2025-01-26
**Status**: Research Complete — Decision implemented as VM Agent
**Context**: Replacing complex Claude Code UI with simple, secure browser terminal access

---

## Table of Contents

1. [Problem Statement](#problem-statement)
2. [Architecture Overview](#architecture-overview)
3. [Multi-Tenant SaaS Model](#multi-tenant-saas-model)
4. [Authentication with BetterAuth](#authentication-with-betterauth)
5. [Cloudflare Deployment Strategy](#cloudflare-deployment-strategy)
6. [Security Architecture](#security-architecture)
7. [JWT Authentication](#jwt-authentication)
8. [VM Agent](#vm-agent)
9. [GitHub Authentication](#github-authentication)
10. [Component Deep Dive](#component-deep-dive)
11. [Sequence Diagrams](#sequence-diagrams)
12. [Implementation Tiers](#implementation-tiers)
13. [Resources](#resources)

---

## Problem Statement

The current Claude Code UI ("CloudCLI") is proving unstable and complex. We need a simpler architecture that:

1. Spins up VMs with Docker
2. Runs devcontainers with known environments
3. Injects git credentials securely
4. Provides browser-based terminal access

**Key Insight**: The terminal server runs **outside** the devcontainer but executes **into** it:
```bash
ttyd devcontainer exec --workspace-folder /workspace bash
```

**Design Principles (Updated 2025-01-26):**
1. **No complex local testing** - Too many moving pieces. Iterate directly on Cloudflare.
2. **Proper auth from day 1** - GitHub OAuth via BetterAuth, no shortcuts.
3. **User brings their own cloud** - Users provide their Hetzner API key.
4. **Easy deploy/teardown** - Single command to deploy or destroy entire system.

---

## Architecture Overview

### High-Level Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              USER'S BROWSER                                  │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────────────────────────┐  │
│  │  Control    │    │  Terminal   │    │  xterm.js (WebSocket client)    │  │
│  │  Plane UI   │    │  Window     │    │  - Renders terminal output      │  │
│  │  (React)    │    │  (ttyd)     │    │  - Sends keystrokes             │  │
│  └──────┬──────┘    └──────┬──────┘    └─────────────────────────────────┘  │
└─────────┼──────────────────┼────────────────────────────────────────────────┘
          │                  │
          │ HTTPS            │ WSS (WebSocket Secure)
          ▼                  ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                         CLOUDFLARE EDGE                                      │
│                                                                              │
│  ┌──────────────────┐  ┌──────────────────┐  ┌────────────────────────────┐ │
│  │  DNS Resolution  │  │  Proxy (Orange)  │  │  Cloudflare Access         │ │
│  │                  │  │  - SSL termination│  │  (Optional - Tier 2)       │ │
│  │  api.domain.com  │  │  - DDoS protect  │  │  - GitHub OAuth            │ │
│  │  ws-*.domain.com │  │  - WebSocket     │  │  - JWT cookies             │ │
│  └──────────────────┘  └──────────────────┘  └────────────────────────────┘ │
└────────────┬────────────────────┬───────────────────────────────────────────┘
             │                    │
             │ HTTPS              │ HTTP/WS (proxied, internal)
             ▼                    ▼
┌────────────────────┐  ┌─────────────────────────────────────────────────────┐
│  CLOUDFLARE WORKER │  │                    HETZNER VM                        │
│  (Control Plane)   │  │  ws-{id}.workspaces.domain.com                       │
│                    │  │                                                      │
│  ┌──────────────┐  │  │  ┌────────────────────────────────────────────────┐ │
│  │ Hono API     │  │  │  │  HOST LAYER                                    │ │
│  │              │  │  │  │                                                │ │
│  │ POST /vms    │  │  │  │  ┌─────────────┐  ┌─────────────────────────┐ │ │
│  │ GET  /vms    │  │  │  │  │ ttyd        │  │ credential-refresh.sh   │ │ │
│  │ DELETE /vms  │  │  │  │  │ :7681       │  │ (cron, every 45min)     │ │ │
│  │              │  │  │  │  │             │  │                         │ │ │
│  │ Manages:     │  │  │  │  │ Executes:   │  │ Calls API for fresh     │ │ │
│  │ - Hetzner    │  │  │  │  │ devcontainer│  │ GitHub tokens           │ │ │
│  │ - DNS        │  │  │  │  │ exec bash   │  │                         │ │ │
│  │ - Tokens     │  │  │  │  └──────┬──────┘  └─────────────────────────┘ │ │
│  └──────────────┘  │  │  │         │                                      │ │
│                    │  │  │         ▼                                      │ │
│  ┌──────────────┐  │  │  │  ┌─────────────────────────────────────────┐  │ │
│  │ KV Storage   │  │  │  │  │  /var/secrets/                          │  │ │
│  │              │  │  │  │  │  ├── workspace-token  (API auth)        │  │ │
│  │ workspace:id │  │  │  │  │  ├── github-token    (git auth)         │  │ │
│  │ → metadata   │  │  │  │  │  └── terminal-pass   (ttyd auth)        │  │ │
│  └──────────────┘  │  │  │  └─────────────────────────────────────────┘  │ │
└────────────────────┘  │  └────────────────────────────────────────────────┘ │
                        │                                                      │
                        │  ┌────────────────────────────────────────────────┐ │
                        │  │  DOCKER                                        │ │
                        │  │                                                │ │
                        │  │  ┌──────────────────────────────────────────┐ │ │
                        │  │  │  DEVCONTAINER                            │ │ │
                        │  │  │                                          │ │ │
                        │  │  │  /workspace (user's repo)                │ │ │
                        │  │  │                                          │ │ │
                        │  │  │  ┌────────────────────────────────────┐ │ │ │
                        │  │  │  │ Claude Code CLI                    │ │ │ │
                        │  │  │  │ (via devcontainer feature)         │ │ │ │
                        │  │  │  └────────────────────────────────────┘ │ │ │
                        │  │  │                                          │ │ │
                        │  │  │  ┌────────────────────────────────────┐ │ │ │
                        │  │  │  │ Git + Credential Helper            │ │ │ │
                        │  │  │  │ (reads from mounted secrets)       │ │ │ │
                        │  │  │  └────────────────────────────────────┘ │ │ │
                        │  │  │                                          │ │ │
                        │  │  └──────────────────────────────────────────┘ │ │
                        │  └────────────────────────────────────────────────┘ │
                        └─────────────────────────────────────────────────────┘
```

### Simplified MVP Architecture

```
┌──────────────┐     HTTPS      ┌─────────────┐     HTTP      ┌─────────────┐
│   Browser    │ ─────────────► │  Cloudflare │ ────────────► │   Hetzner   │
│   (xterm.js) │ ◄───────────── │   Proxy     │ ◄──────────── │   VM:7681   │
└──────────────┘    WebSocket   └─────────────┘   WebSocket   │   (ttyd)    │
                                                              └──────┬──────┘
                                                                     │
                                                                     ▼
                                                              ┌─────────────┐
                                                              │ devcontainer│
                                                              │   + Claude  │
                                                              │   + Git     │
                                                              └─────────────┘
```

---

## Multi-Tenant SaaS Model

Users bring their own Hetzner account. We manage auth, workspace metadata, and orchestration.

### What We Store

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         DATA WE STORE (Cloudflare D1)                        │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ✓ User profiles (from GitHub OAuth)                                        │
│  ✓ User's Hetzner API token (AES-GCM encrypted)                             │
│  ✓ Workspace metadata (name, repo, status, VM ID)                           │
│  ✓ JWT signing keys                                                         │
│  ✓ Sessions and rate limiting data (KV)                                     │
│                                                                              │
│  ✗ NOT the VMs (they're on user's Hetzner account)                          │
│  ✗ NOT the code (it's on GitHub and in their VMs)                           │
│  ✗ NOT GitHub tokens for repos (user's PAT, stored only on VM)              │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Database Schema (D1/SQLite)

```sql
-- BetterAuth auto-generates: users, sessions, accounts, verification_tokens

-- User's cloud provider credentials (encrypted)
CREATE TABLE user_credentials (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,  -- 'hetzner' (future: 'aws', 'gcp')
    encrypted_token TEXT NOT NULL,  -- AES-GCM encrypted
    iv TEXT NOT NULL,  -- Initialization vector for decryption
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(user_id, provider)
);

-- Workspaces
CREATE TABLE workspaces (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    repo_url TEXT NOT NULL,
    branch TEXT DEFAULT 'main',
    status TEXT NOT NULL,  -- 'creating', 'running', 'stopped', 'error'
    vm_id TEXT,  -- Hetzner server ID
    vm_ip TEXT,
    dns_record_id TEXT,  -- Cloudflare DNS record ID
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_activity_at INTEGER
);
```

### User Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              USER FLOW                                       │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  1. FIRST VISIT                                                              │
│     ┌───────────────────────────────────────────────────────────────────┐   │
│     │ • User visits https://workspaces.example.com                      │   │
│     │ • Clicks "Sign in with GitHub"                                    │   │
│     │ • BetterAuth handles OAuth flow                                   │   │
│     │ • User is now authenticated                                       │   │
│     └───────────────────────────────────────────────────────────────────┘   │
│                                                                              │
│  2. SETUP (First Time)                                                       │
│     ┌───────────────────────────────────────────────────────────────────┐   │
│     │ • User goes to Settings                                           │   │
│     │ • Enters their Hetzner API token                                  │   │
│     │ • We encrypt with AES-GCM and store in D1                         │   │
│     │ • User is now ready to create workspaces                          │   │
│     └───────────────────────────────────────────────────────────────────┘   │
│                                                                              │
│  3. CREATE WORKSPACE                                                         │
│     ┌───────────────────────────────────────────────────────────────────┐   │
│     │ • User enters GitHub repo URL (+ optional PAT for private repos)  │   │
│     │ • We decrypt their Hetzner token                                  │   │
│     │ • We create VM on THEIR Hetzner account                           │   │
│     │ • We create DNS: ws-{id}.workspaces.example.com → VM IP           │   │
│     │ • VM boots, runs cloud-init, installs VM Agent                    │   │
│     │ • VM calls back to say "ready"                                    │   │
│     └───────────────────────────────────────────────────────────────────┘   │
│                                                                              │
│  4. ACCESS TERMINAL                                                          │
│     ┌───────────────────────────────────────────────────────────────────┐   │
│     │ • User clicks "Open Terminal"                                     │   │
│     │ • Control plane verifies user owns workspace                      │   │
│     │ • Control plane issues JWT with workspace claim                   │   │
│     │ • Redirects to VM with JWT                                        │   │
│     │ • VM Agent validates JWT, proxies to ttyd                         │   │
│     │ • Terminal appears!                                               │   │
│     └───────────────────────────────────────────────────────────────────┘   │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Authentication with BetterAuth

We use [BetterAuth](https://better-auth.com) with the [better-auth-cloudflare](https://github.com/zpg6/better-auth-cloudflare) package for Cloudflare-native authentication.

### Why BetterAuth

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         WHY BETTERAUTH                                       │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ✓ Cloudflare-native: Works with D1, KV, Workers out of the box             │
│  ✓ GitHub OAuth built-in                                                    │
│  ✓ Session management handled                                               │
│  ✓ Rate limiting included                                                   │
│  ✓ TypeScript-first                                                         │
│  ✓ Framework-agnostic (works with Hono)                                     │
│  ✓ CLI to generate schema and boilerplate                                   │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### BetterAuth Configuration

```typescript
// apps/api/src/auth.ts
import type { D1Database, IncomingRequestCfProperties } from "@cloudflare/workers-types";
import { betterAuth } from "better-auth";
import { withCloudflare } from "better-auth-cloudflare";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { drizzle } from "drizzle-orm/d1";
import { schema } from "./db/schema";

export function createAuth(env: CloudflareBindings, cf?: IncomingRequestCfProperties) {
    const db = drizzle(env.DATABASE, { schema });

    return betterAuth({
        ...withCloudflare({
            autoDetectIpAddress: true,
            geolocationTracking: true,
            cf: cf || {},
            d1: {
                db,
                options: { usePlural: true },
            },
            kv: env.KV,
        }, {
            // GitHub OAuth
            socialProviders: {
                github: {
                    clientId: env.GITHUB_CLIENT_ID,
                    clientSecret: env.GITHUB_CLIENT_SECRET,
                },
            },
            // Rate limiting
            rateLimit: {
                enabled: true,
                window: 60,
                max: 100,
            },
        }),
    });
}
```

### API Integration (Hono)

```typescript
// apps/api/src/index.ts
import { Hono } from 'hono';
import { createAuth } from './auth';

const app = new Hono<{ Bindings: CloudflareBindings }>();

// BetterAuth handles /api/auth/*
app.on(['GET', 'POST'], '/api/auth/*', (c) => {
    const auth = createAuth(c.env, c.req.raw.cf);
    return auth.handler(c.req.raw);
});

// JWKS endpoint for VM Agents
app.get('/.well-known/jwks.json', async (c) => {
    const publicKey = await getPublicKeyJWK(c.env);
    return c.json({ keys: [publicKey] });
});

// Auth middleware for protected routes
const requireAuth = async (c, next) => {
    const auth = createAuth(c.env, c.req.raw.cf);
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) return c.json({ error: 'Unauthorized' }, 401);
    c.set('user', session.user);
    return next();
};

// Protected routes
app.use('/api/credentials/*', requireAuth);
app.use('/api/workspaces/*', requireAuth);

// ... route handlers
```

### React Client

```typescript
// apps/web/src/lib/auth.ts
import { createAuthClient } from 'better-auth/react';

export const authClient = createAuthClient({
    baseURL: import.meta.env.VITE_API_URL,
});

// In components:
export function useAuth() {
    const { data: session, isPending } = authClient.useSession();

    const signIn = () => authClient.signIn.social({ provider: 'github' });
    const signOut = () => authClient.signOut();

    return { session, isPending, signIn, signOut };
}
```

---

## Cloudflare Deployment Strategy

Everything deploys with a single command. No complex local setup needed.

### Cloudflare Resources

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                      CLOUDFLARE RESOURCES                                    │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  CLOUDFLARE PAGES (Web UI)                                                   │
│  • React + Vite application                                                  │
│  • URL: https://workspaces.example.com                                       │
│  • Auto-deploys from main branch                                             │
│                                                                              │
│  CLOUDFLARE WORKERS (API)                                                    │
│  • Hono API + BetterAuth                                                     │
│  • URL: https://api.workspaces.example.com                                   │
│  • Custom domain with TLS                                                    │
│                                                                              │
│  CLOUDFLARE D1 (Database)                                                    │
│  • SQLite at the edge                                                        │
│  • User profiles, credentials, workspaces                                    │
│  • BetterAuth tables                                                         │
│                                                                              │
│  CLOUDFLARE KV (Key-Value)                                                   │
│  • Session storage                                                           │
│  • Rate limiting counters                                                    │
│  • JWKS cache                                                                │
│                                                                              │
│  CLOUDFLARE DNS                                                              │
│  • Workspace subdomains: ws-{id}.workspaces.example.com                      │
│  • Dynamic A records pointing to VM IPs                                      │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Project Structure

```
/
├── apps/
│   ├── api/                      # Cloudflare Worker
│   │   ├── src/
│   │   │   ├── index.ts          # Hono app entry
│   │   │   ├── auth.ts           # BetterAuth config
│   │   │   ├── routes/
│   │   │   │   ├── credentials.ts
│   │   │   │   ├── workspaces.ts
│   │   │   │   └── terminal.ts
│   │   │   ├── services/
│   │   │   │   ├── hetzner.ts    # Hetzner API client
│   │   │   │   ├── dns.ts        # Cloudflare DNS
│   │   │   │   ├── encryption.ts # AES-GCM for tokens
│   │   │   │   └── jwt.ts        # JWT signing
│   │   │   └── db/
│   │   │       ├── schema.ts     # Drizzle schema
│   │   │       └── migrations/
│   │   ├── wrangler.toml
│   │   └── package.json
│   │
│   └── web/                      # Cloudflare Pages
│       ├── src/
│       │   ├── App.tsx
│       │   ├── pages/
│       │   │   ├── Landing.tsx
│       │   │   ├── Dashboard.tsx
│       │   │   ├── Settings.tsx
│       │   │   └── Workspace.tsx
│       │   ├── components/
│       │   └── lib/
│       │       └── auth.ts       # BetterAuth client
│       └── package.json
│
├── packages/
│   └── vm-agent/                 # Single Go binary with embedded UI
│       ├── main.go
│       ├── go.mod
│       ├── embed.go              # //go:embed ui/dist/*
│       ├── internal/             # Go packages (auth, pty, server)
│       ├── ui/                   # React app (compiled into binary)
│       │   ├── src/
│       │   └── package.json
│       ├── Makefile
│       └── .goreleaser.yml       # Multi-arch release
│
├── scripts/
│   ├── deploy.ts                 # Deploy everything
│   ├── teardown.ts               # Destroy everything
│   ├── setup.ts                  # First-time setup (secrets)
│   └── generate-keys.ts          # Generate JWT keypair
│
├── wrangler.toml                 # Shared Wrangler config
└── turbo.json
```

### wrangler.toml (API)

```toml
name = "workspaces-api"
main = "src/index.ts"
compatibility_date = "2024-01-01"

# D1 Database
[[d1_databases]]
binding = "DATABASE"
database_name = "workspaces"
database_id = "auto"  # Filled by deploy script

# KV Namespace
[[kv_namespaces]]
binding = "KV"
id = "auto"  # Filled by deploy script

# Environment variables
[vars]
ENVIRONMENT = "production"
JWKS_CACHE_TTL = "3600"

# Secrets (set via wrangler secret put):
# GITHUB_CLIENT_ID
# GITHUB_CLIENT_SECRET
# JWT_PRIVATE_KEY
# JWT_PUBLIC_KEY
# ENCRYPTION_KEY
# CF_API_TOKEN (for DNS management)
# CF_ZONE_ID

# Staging environment
[env.staging]
name = "workspaces-api-staging"
vars = { ENVIRONMENT = "staging" }
```

### Deploy Script

```typescript
// scripts/deploy.ts
#!/usr/bin/env tsx
import { $ } from 'execa';

const env = process.argv[2] || 'production';

async function deploy() {
    console.log(`🚀 Deploying to ${env}...\n`);

    // 1. Create D1 database
    console.log('📦 Setting up D1 database...');
    try {
        await $`wrangler d1 create workspaces-${env}`;
    } catch (e) {
        console.log('   Database already exists, continuing...');
    }

    // 2. Create KV namespace
    console.log('📦 Setting up KV namespace...');
    try {
        await $`wrangler kv:namespace create KV_${env.toUpperCase()}`;
    } catch (e) {
        console.log('   KV namespace already exists, continuing...');
    }

    // 3. Run database migrations
    console.log('🔄 Running migrations...');
    await $`pnpm --filter @workspaces/api db:migrate:${env}`;

    // 4. Build and deploy API
    console.log('🔨 Building API...');
    await $`pnpm --filter @workspaces/api build`;
    console.log('☁️  Deploying API to Workers...');
    await $`pnpm --filter @workspaces/api wrangler deploy ${env === 'production' ? '' : `--env ${env}`}`;

    // 5. Build and deploy Web UI
    console.log('🔨 Building Web UI...');
    await $`pnpm --filter @workspaces/web build`;
    console.log('☁️  Deploying Web UI to Pages...');
    await $`pnpm --filter @workspaces/web wrangler pages deploy dist --project-name workspaces-${env}`;

    console.log('\n✅ Deployment complete!');
    console.log(`   API: https://api${env === 'staging' ? '-staging' : ''}.workspaces.example.com`);
    console.log(`   Web: https://${env === 'staging' ? 'staging.' : ''}workspaces.example.com`);
}

deploy().catch(console.error);
```

### Teardown Script

```typescript
// scripts/teardown.ts
#!/usr/bin/env tsx
import { $ } from 'execa';
import { confirm } from '@inquirer/prompts';

const env = process.argv[2] || 'production';

async function teardown() {
    const confirmed = await confirm({
        message: `⚠️  This will DELETE ALL DATA for ${env}. Are you sure?`,
        default: false,
    });

    if (!confirmed) {
        console.log('Cancelled.');
        return;
    }

    console.log(`🗑️  Tearing down ${env}...\n`);

    // Delete Worker
    console.log('Deleting Worker...');
    await $`wrangler delete workspaces-api-${env}`.catch(() => {});

    // Delete Pages project
    console.log('Deleting Pages project...');
    await $`wrangler pages project delete workspaces-${env}`.catch(() => {});

    // Delete D1 database
    console.log('Deleting D1 database...');
    await $`wrangler d1 delete workspaces-${env}`.catch(() => {});

    // Delete KV namespace
    console.log('Deleting KV namespace...');
    await $`wrangler kv:namespace delete KV_${env.toUpperCase()}`.catch(() => {});

    console.log('\n✅ Teardown complete!');
}

teardown().catch(console.error);
```

### First-Time Setup Script

```typescript
// scripts/setup.ts
#!/usr/bin/env tsx
import { $ } from 'execa';
import { input, password } from '@inquirer/prompts';
import * as crypto from 'crypto';

async function setup() {
    console.log('🚀 Workspaces First-Time Setup\n');

    // GitHub OAuth instructions
    console.log('📝 First, create a GitHub OAuth App:');
    console.log('   1. Go to https://github.com/settings/developers');
    console.log('   2. Click "New OAuth App"');
    console.log('   3. Homepage URL: https://workspaces.example.com');
    console.log('   4. Callback URL: https://api.workspaces.example.com/api/auth/callback/github');
    console.log('   5. Copy the Client ID and Client Secret\n');

    const githubClientId = await input({ message: 'GitHub Client ID:' });
    const githubClientSecret = await password({ message: 'GitHub Client Secret:' });

    // Cloudflare API token
    console.log('\n📝 Now, create a Cloudflare API token with:');
    console.log('   - Zone:DNS:Edit permission');
    console.log('   - Zone:Zone:Read permission\n');

    const cfApiToken = await password({ message: 'Cloudflare API Token:' });
    const cfZoneId = await input({ message: 'Cloudflare Zone ID:' });

    // Generate keys
    console.log('\n🔐 Generating cryptographic keys...');
    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const encryptionKey = crypto.randomBytes(32).toString('base64');

    // Set secrets
    console.log('\n☁️  Setting Cloudflare secrets...');
    const secrets = {
        GITHUB_CLIENT_ID: githubClientId,
        GITHUB_CLIENT_SECRET: githubClientSecret,
        CF_API_TOKEN: cfApiToken,
        CF_ZONE_ID: cfZoneId,
        JWT_PRIVATE_KEY: privateKey,
        JWT_PUBLIC_KEY: publicKey,
        ENCRYPTION_KEY: encryptionKey,
    };

    for (const [key, value] of Object.entries(secrets)) {
        await $`echo ${value} | wrangler secret put ${key}`;
        console.log(`   ✓ Set ${key}`);
    }

    console.log('\n✅ Setup complete!');
    console.log('   Run `pnpm deploy` to deploy the application.');
}

setup().catch(console.error);
```

### Package.json Scripts

```json
{
    "scripts": {
        "deploy": "tsx scripts/deploy.ts",
        "deploy:staging": "tsx scripts/deploy.ts staging",
        "teardown": "tsx scripts/teardown.ts",
        "teardown:staging": "tsx scripts/teardown.ts staging",
        "setup": "tsx scripts/setup.ts",
        "dev": "turbo dev",
        "build": "turbo build",
        "typecheck": "turbo typecheck"
    }
}
```

---

## Security Architecture

### Defense in Depth Layers

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  LAYER 1: NETWORK EDGE (Cloudflare)                                         │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │ • DDoS protection          • WAF rules                                │  │
│  │ • Rate limiting            • Bot management                           │  │
│  │ • SSL/TLS termination      • IP reputation                            │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
├─────────────────────────────────────────────────────────────────────────────┤
│  LAYER 2: AUTHENTICATION (Who are you?)                                     │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │ MVP: ttyd --credential user:randompassword                            │  │
│  │ Tier 2: Cloudflare Access with GitHub OAuth                           │  │
│  │ Tier 3: mTLS + Service Tokens                                         │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
├─────────────────────────────────────────────────────────────────────────────┤
│  LAYER 3: AUTHORIZATION (What can you do?)                                  │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │ • Workspace isolation (one user per VM)                               │  │
│  │ • GitHub token scoped to specific repos                               │  │
│  │ • Container runs as non-root user                                     │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
├─────────────────────────────────────────────────────────────────────────────┤
│  LAYER 4: TRANSPORT SECURITY                                                │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │ • Browser ↔ Cloudflare: TLS 1.3                                       │  │
│  │ • Cloudflare ↔ Origin: Full (Strict) SSL mode                         │  │
│  │ • WebSocket upgrade over encrypted channel                            │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
├─────────────────────────────────────────────────────────────────────────────┤
│  LAYER 5: CONTAINER ISOLATION                                               │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │ • Non-privileged container                                            │  │
│  │ • Read-only root filesystem (where possible)                          │  │
│  │ • Only /workspace mounted read-write                                  │  │
│  │ • Network egress restrictions (optional)                              │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
├─────────────────────────────────────────────────────────────────────────────┤
│  LAYER 6: CREDENTIAL SECURITY                                               │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │ • Short-lived tokens (1 hour max)                                     │  │
│  │ • Tokens stored in memory/tmpfs only                                  │  │
│  │ • Credential helper pattern (never in git config)                     │  │
│  │ • Auto-destruction on VM shutdown                                     │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Authentication Options Comparison

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        AUTHENTICATION OPTIONS                                │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  OPTION A: Control Plane JWT (RECOMMENDED - MVP)                             │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │                                                                        │ │
│  │   Browser        Control Plane       VM Agent        ttyd              │ │
│  │      │               │                   │             │               │ │
│  │      │─"Open Term"──►│                   │             │               │ │
│  │      │               │                   │             │               │ │
│  │      │  (verify user session + workspace ownership)   │               │ │
│  │      │               │                   │             │               │ │
│  │      │◄─ 302 + JWT ──│                   │             │               │ │
│  │      │  (redirect to VM with token)      │             │               │ │
│  │      │               │                   │             │               │ │
│  │      │───────────────┼── GET /?token= ──►│             │               │ │
│  │      │               │                   │             │               │ │
│  │      │               │◄─ Fetch JWKS ─────│             │               │ │
│  │      │               │── Return keys ───►│             │               │ │
│  │      │               │                   │             │               │ │
│  │      │               │   (validate JWT signature,     │               │ │
│  │      │               │    expiry, workspace claim)    │               │ │
│  │      │               │                   │             │               │ │
│  │      │◄──────────────┼─ Set session ─────│             │               │ │
│  │      │               │   cookie + proxy  │────────────►│               │ │
│  │      │◄══════════════┼═══ Terminal ══════┼═════════════│               │ │
│  │                                                                        │ │
│  │   Benefits:                                                            │ │
│  │   • No passwords to manage or display                                  │ │
│  │   • Control plane handles all user authentication                      │ │
│  │   • VM agent only validates JWTs (simple, stateless)                   │ │
│  │   • JWKS endpoint allows key rotation without VM updates               │ │
│  │                                                                        │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
│                                                                              │
│  OPTION B: ttyd Basic Auth (DEPRECATED - too manual)                         │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │   Password-based auth requires showing password to user.               │ │
│  │   Poor UX and security compared to JWT flow.                           │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
│                                                                              │
│  OPTION C: Cloudflare Access (FUTURE - if needed)                            │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │   Could add CF Access in front for additional protection.              │ │
│  │   Would layer on top of our JWT auth, not replace it.                  │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### ttyd Security Configuration

```bash
# MVP: Basic auth with random password
ttyd \
  --port 7681 \
  --credential "workspace:$(cat /var/secrets/terminal-pass)" \
  --check-origin \
  --max-clients 3 \
  devcontainer exec --workspace-folder /workspace bash

# Tier 2: Behind Cloudflare Access (auth handled externally)
ttyd \
  --port 7681 \
  --interface 127.0.0.1 \           # Only localhost
  --auth-header X-WEBAUTH-USER \    # Trust CF Access header
  --check-origin \
  --max-clients 3 \
  devcontainer exec --workspace-folder /workspace bash
```

---

## JWT Authentication

The control plane issues JWTs for terminal access. This replaces password-based auth with a seamless redirect flow.

### Control Plane JWT Infrastructure

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                     CONTROL PLANE JWT INFRASTRUCTURE                         │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  COMPONENTS                                                                  │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │                                                                      │   │
│  │  1. KEY PAIR (stored in Worker secrets)                              │   │
│  │     • Algorithm: RS256 (RSA) or ES256 (EC) - both work in Workers    │   │
│  │     • Private key: Signs JWTs                                        │   │
│  │     • Public key: Exposed via JWKS endpoint                          │   │
│  │                                                                      │   │
│  │  2. JWKS ENDPOINT: GET /.well-known/jwks.json                        │   │
│  │     {                                                                │   │
│  │       "keys": [{                                                     │   │
│  │         "kty": "RSA",                                                │   │
│  │         "kid": "key-2025-01",                                        │   │
│  │         "use": "sig",                                                │   │
│  │         "alg": "RS256",                                              │   │
│  │         "n": "...",    // modulus                                    │   │
│  │         "e": "AQAB"    // exponent                                   │   │
│  │       }]                                                             │   │
│  │     }                                                                │   │
│  │                                                                      │   │
│  │  3. TOKEN ENDPOINT: GET /auth/terminal?workspace={id}                │   │
│  │     • Validates user session                                         │   │
│  │     • Checks user owns workspace                                     │   │
│  │     • Issues JWT and redirects to VM                                 │   │
│  │                                                                      │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
│  JWT CLAIMS                                                                  │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │  {                                                                   │   │
│  │    "iss": "https://api.workspaces.example.com",                      │   │
│  │    "sub": "user_12345",                                              │   │
│  │    "aud": "workspace-terminal",                                      │   │
│  │    "workspace": "ws-abc123",                                         │   │
│  │    "iat": 1706000000,                                                │   │
│  │    "exp": 1706003600   // 1 hour expiry                              │   │
│  │  }                                                                   │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
│  IMPLEMENTATION (Cloudflare Worker with jose library)                        │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │  import { SignJWT, importPKCS8 } from 'jose';                        │   │
│  │                                                                      │   │
│  │  const privateKey = await importPKCS8(env.JWT_PRIVATE_KEY, 'RS256'); │   │
│  │                                                                      │   │
│  │  const jwt = await new SignJWT({                                     │   │
│  │    workspace: workspaceId,                                           │   │
│  │  })                                                                  │   │
│  │    .setProtectedHeader({ alg: 'RS256', kid: 'key-2025-01' })         │   │
│  │    .setIssuer('https://api.workspaces.example.com')                  │   │
│  │    .setSubject(userId)                                               │   │
│  │    .setAudience('workspace-terminal')                                │   │
│  │    .setExpirationTime('1h')                                          │   │
│  │    .sign(privateKey);                                                │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Terminal Access Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                       TERMINAL ACCESS FLOW                                   │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  Browser          Control Plane        VM Agent           ttyd               │
│     │                  │                   │                │                │
│     │ 1. User clicks "Open Terminal" for workspace ws-123  │                │
│     │──GET /auth/terminal?workspace=ws-123                 │                │
│     │                  │                   │                │                │
│     │                  │ 2. Check user session (cookie)    │                │
│     │                  │ 3. Verify user owns ws-123        │                │
│     │                  │ 4. Generate JWT with claims:      │                │
│     │                  │    - sub: user_id                 │                │
│     │                  │    - workspace: ws-123            │                │
│     │                  │    - exp: now + 1 hour            │                │
│     │                  │                   │                │                │
│     │◄─────────────────│                   │                │                │
│     │ 5. 302 Redirect to:                  │                │                │
│     │    https://ws-123.workspaces.example.com/?token=JWT  │                │
│     │                  │                   │                │                │
│     │──────────────────┼───GET /?token=JWT►│                │                │
│     │                  │                   │                │                │
│     │                  │ 6. Fetch JWKS     │                │                │
│     │                  │   (cached 1hr)    │                │                │
│     │                  │◄──────────────────│                │                │
│     │                  │──────────────────►│                │                │
│     │                  │                   │                │                │
│     │                  │ 7. Validate JWT:  │                │                │
│     │                  │    - Signature vs JWKS             │                │
│     │                  │    - Expiration                    │                │
│     │                  │    - Issuer                        │                │
│     │                  │    - Workspace claim matches       │                │
│     │                  │                   │                │                │
│     │◄─────────────────┼───────────────────│                │                │
│     │ 8. Set-Cookie: session=xxx           │                │                │
│     │    (VM agent's own session)          │                │                │
│     │                  │                   │                │                │
│     │──────────────────┼─ GET / (cookie) ─►│                │                │
│     │                  │                   │───────────────►│                │
│     │◄═════════════════┼═══ Terminal ══════┼════════════════│                │
│     │                  │                   │                │                │
│                                                                              │
│  SUBSEQUENT REQUESTS                                                         │
│  • Browser sends VM agent session cookie                                     │
│  • VM agent validates session, proxies to ttyd                               │
│  • No JWT needed after initial auth                                          │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Key Rotation

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           KEY ROTATION                                       │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  JWKS supports multiple keys, enabling zero-downtime rotation:               │
│                                                                              │
│  1. Generate new key pair with new kid (e.g., "key-2025-02")                 │
│  2. Add new public key to JWKS (now has 2 keys)                              │
│  3. Start signing new JWTs with new key                                      │
│  4. Wait for old JWTs to expire (max 1 hour)                                 │
│  5. Remove old key from JWKS                                                 │
│                                                                              │
│  VM agents cache JWKS for ~1 hour, so rotation is seamless.                  │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## VM Agent

A single Go binary that runs directly on the VM host. It serves the terminal web UI, manages PTY sessions, handles authentication, and provides workspace lifecycle management.

**Key insight: No Docker for the agent.** It runs directly on the host and executes commands into the devcontainer via `devcontainer exec`.

### Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          VM AGENT ARCHITECTURE                               │
│                        (Single Go Binary)                                    │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  HETZNER VM                                                                  │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │                                                                      │   │
│  │   Port 443 (HTTPS)                                                   │   │
│  │        │                                                             │   │
│  │        ▼                                                             │   │
│  │   ┌─────────────────────────────────────────────────────────────┐   │   │
│  │   │                      VM AGENT                                │   │   │
│  │   │                 (Single Go Binary)                           │   │   │
│  │   │                                                              │   │   │
│  │   │  ┌────────────────────────────────────────────────────────┐ │   │   │
│  │   │  │              EMBEDDED WEB UI                            │ │   │   │
│  │   │  │           (React + xterm.js)                            │ │   │   │
│  │   │  │                                                         │ │   │   │
│  │   │  │  • Terminal view (full screen xterm.js)                │ │   │   │
│  │   │  │  • Session list (multiple terminals)                   │ │   │   │
│  │   │  │  • Status bar (workspace info, connection)             │ │   │   │
│  │   │  │  • File browser (future)                               │ │   │   │
│  │   │  └────────────────────────────────────────────────────────┘ │   │   │
│  │   │                                                              │   │   │
│  │   │  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐  │   │   │
│  │   │  │ HTTP Server │  │ WebSocket   │  │ PTY Manager         │  │   │   │
│  │   │  │             │  │ Handler     │  │                     │  │   │   │
│  │   │  │ • Serve UI  │  │             │  │ • Spawn shells      │  │   │   │
│  │   │  │ • Static    │  │ • Terminal  │  │ • creack/pty lib    │  │   │   │
│  │   │  │   files     │  │   I/O       │  │ • Resize handling   │  │   │   │
│  │   │  │ • API       │  │ • Heartbeat │  │ • Session cleanup   │  │   │   │
│  │   │  └─────────────┘  └─────────────┘  └──────────┬──────────┘  │   │   │
│  │   │                                               │              │   │   │
│  │   │  ┌─────────────┐  ┌─────────────┐  ┌─────────▼───────────┐  │   │   │
│  │   │  │ JWT Auth    │  │ Idle        │  │ Shell Execution     │  │   │   │
│  │   │  │             │  │ Detection   │  │                     │  │   │   │
│  │   │  │ • Fetch JWKS│  │             │  │ devcontainer exec   │  │   │   │
│  │   │  │ • Validate  │  │ • Track     │  │ --workspace-folder  │  │   │   │
│  │   │  │ • Sessions  │  │   activity  │  │ /workspace bash     │  │   │   │
│  │   │  └─────────────┘  └─────────────┘  └─────────────────────┘  │   │   │
│  │   │                                                              │   │   │
│  │   └──────────────────────────────────────────────────────────────┘   │   │
│  │                                                                      │   │
│  │   ┌──────────────────────────────────────────────────────────────┐   │   │
│  │   │                   DEVCONTAINER (Docker)                       │   │   │
│  │   │                                                               │   │   │
│  │   │   /workspace (user's repo)                                    │   │   │
│  │   │   Claude Code CLI                                             │   │   │
│  │   │   Git + credential helper                                     │   │   │
│  │   │                                                               │   │   │
│  │   └──────────────────────────────────────────────────────────────┘   │   │
│  │                                                                      │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Why No Separate ttyd?

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                   PTY HANDLING: AGENT VS TTYD                                │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  OPTION A: Agent proxies to ttyd (REJECTED)                                 │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │ VM Agent (auth, proxy) → ttyd (PTY, UI) → devcontainer                 │ │
│  │                                                                        │ │
│  │ Problems:                                                              │ │
│  │ • Two processes to manage                                              │ │
│  │ • ttyd serves its own UI (we don't want that)                          │ │
│  │ • Extra complexity for little benefit                                  │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
│                                                                              │
│  OPTION B: Agent handles PTY directly (CHOSEN)                               │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │ VM Agent (everything) → devcontainer                                   │ │
│  │                                                                        │ │
│  │ Benefits:                                                              │ │
│  │ • Single process                                                       │ │
│  │ • Full control over UI                                                 │ │
│  │ • Simpler deployment                                                   │ │
│  │ • Uses github.com/creack/pty (battle-tested Go PTY library)           │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Technology Stack

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         VM AGENT TECH STACK                                  │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  GO BINARY                                                                   │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │ • Single static binary (~15-20MB, ~5-8MB with UPX compression)         │ │
│  │ • No runtime dependencies                                              │ │
│  │ • Fast startup (milliseconds)                                          │ │
│  │ • Cross-compile for linux/amd64, linux/arm64                           │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
│                                                                              │
│  KEY GO DEPENDENCIES                                                         │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │ • github.com/creack/pty          - PTY spawning and management         │ │
│  │ • github.com/gorilla/websocket   - WebSocket server                    │ │
│  │ • github.com/golang-jwt/jwt/v5   - JWT validation                      │ │
│  │ • embed (stdlib)                 - Embed static files in binary        │ │
│  │ • net/http (stdlib)              - HTTP server                         │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
│                                                                              │
│  EMBEDDED UI (compiled into binary)                                          │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │ • React + Vite                   - UI framework                        │ │
│  │ • xterm.js                       - Terminal emulator                   │ │
│  │ • @xterm/addon-fit               - Auto-resize terminal                │ │
│  │ • @xterm/addon-web-links         - Clickable URLs                      │ │
│  │ • TailwindCSS                    - Styling                             │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Project Structure

```
packages/
└── vm-agent/
    ├── main.go                 # Entry point
    ├── go.mod
    ├── go.sum
    ├── embed.go                # //go:embed ui/dist/*
    │
    ├── internal/
    │   ├── auth/
    │   │   ├── jwt.go          # JWT validation against JWKS
    │   │   └── session.go      # Session cookie management
    │   ├── pty/
    │   │   ├── manager.go      # Manage multiple PTY sessions
    │   │   └── session.go      # Individual PTY session
    │   ├── server/
    │   │   ├── server.go       # HTTP server setup
    │   │   ├── routes.go       # Route handlers
    │   │   └── websocket.go    # Terminal WebSocket handler
    │   └── config/
    │       └── config.go       # Environment config
    │
    ├── ui/                     # Embedded web UI (React)
    │   ├── package.json
    │   ├── vite.config.ts
    │   ├── index.html
    │   ├── src/
    │   │   ├── App.tsx
    │   │   ├── main.tsx
    │   │   ├── components/
    │   │   │   ├── Terminal.tsx      # xterm.js wrapper
    │   │   │   ├── StatusBar.tsx     # Connection status
    │   │   │   └── SessionList.tsx   # Multiple terminals
    │   │   └── lib/
    │   │       └── websocket.ts      # WebSocket client
    │   └── dist/               # Built at compile time (git-ignored)
    │
    ├── Makefile                # Build commands
    └── .goreleaser.yml         # Multi-arch release automation
```

### Build and Distribution

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                      BUILD AND DISTRIBUTION                                  │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  BUILD PROCESS                                                               │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │ # Makefile                                                             │ │
│  │                                                                        │ │
│  │ build: ui                                                              │ │
│  │     go build -o bin/vm-agent .                                         │ │
│  │                                                                        │ │
│  │ ui:                                                                    │ │
│  │     cd ui && pnpm install && pnpm build                                │ │
│  │                                                                        │ │
│  │ release:                                                               │ │
│  │     goreleaser release --clean                                         │ │
│  │                                                                        │ │
│  │ # Result: single binary with embedded React UI                         │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
│                                                                              │
│  DISTRIBUTION (via GitHub Releases)                                          │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │ • vm-agent-linux-amd64     (~15MB, ~6MB with UPX)                      │ │
│  │ • vm-agent-linux-arm64     (~15MB, ~6MB with UPX)                      │ │
│  │                                                                        │ │
│  │ Download URL:                                                          │ │
│  │ https://github.com/org/repo/releases/download/v1.0.0/vm-agent-linux-amd64 │
│  └────────────────────────────────────────────────────────────────────────┘ │
│                                                                              │
│  INSTALLATION (in cloud-init)                                                │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │ runcmd:                                                                │ │
│  │   # Download vm-agent                                                  │ │
│  │   - curl -Lo /usr/local/bin/vm-agent \                                 │ │
│  │       https://github.com/org/repo/releases/download/v1.0.0/vm-agent-linux-amd64 │
│  │   - chmod +x /usr/local/bin/vm-agent                                   │ │
│  │                                                                        │ │
│  │   # Create systemd service                                             │ │
│  │   - |                                                                  │ │
│  │     cat > /etc/systemd/system/vm-agent.service << 'EOF'                │ │
│  │     [Unit]                                                             │ │
│  │     Description=Workspace VM Agent                                     │ │
│  │     After=network.target docker.service                                │ │
│  │                                                                        │ │
│  │     [Service]                                                          │ │
│  │     Type=simple                                                        │ │
│  │     ExecStart=/usr/local/bin/vm-agent                                  │ │
│  │     EnvironmentFile=/etc/workspace/agent.env                           │ │
│  │     Restart=always                                                     │ │
│  │                                                                        │ │
│  │     [Install]                                                          │ │
│  │     WantedBy=multi-user.target                                         │ │
│  │     EOF                                                                │ │
│  │                                                                        │ │
│  │   - systemctl enable vm-agent                                          │ │
│  │   - systemctl start vm-agent                                           │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### VM Agent Responsibilities

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                      VM AGENT RESPONSIBILITIES                               │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  1. SERVE TERMINAL UI                                                        │
│     ┌───────────────────────────────────────────────────────────────────┐   │
│     │ • Serve embedded React app with xterm.js                          │   │
│     │ • Handle multiple terminal sessions                               │   │
│     │ • Show workspace status, connection info                          │   │
│     └───────────────────────────────────────────────────────────────────┘   │
│                                                                              │
│  2. PTY MANAGEMENT                                                           │
│     ┌───────────────────────────────────────────────────────────────────┐   │
│     │ • Spawn shells via: devcontainer exec --workspace-folder /workspace bash │
│     │ • Use creack/pty for pseudo-terminal handling                     │   │
│     │ • Handle resize events (SIGWINCH)                                 │   │
│     │ • Clean up sessions on disconnect                                 │   │
│     └───────────────────────────────────────────────────────────────────┘   │
│                                                                              │
│  3. WEBSOCKET TERMINAL I/O                                                   │
│     ┌───────────────────────────────────────────────────────────────────┐   │
│     │ • Bidirectional streaming: browser ↔ PTY                          │   │
│     │ • Binary WebSocket messages for raw terminal data                 │   │
│     │ • JSON messages for control (resize, ping/pong)                   │   │
│     └───────────────────────────────────────────────────────────────────┘   │
│                                                                              │
│  4. JWT AUTHENTICATION                                                       │
│     ┌───────────────────────────────────────────────────────────────────┐   │
│     │ • Fetch JWKS from control plane (cache 1 hour)                    │   │
│     │ • Validate JWT on first request (?token=xxx)                      │   │
│     │ • Issue session cookie for subsequent requests                    │   │
│     │ • Verify workspace claim matches this VM                          │   │
│     └───────────────────────────────────────────────────────────────────┘   │
│                                                                              │
│  5. HEALTH & STATUS                                                          │
│     ┌───────────────────────────────────────────────────────────────────┐   │
│     │ • GET /health - Liveness for control plane                        │   │
│     │ • GET /api/status - { workspace, uptime, sessions, lastActivity } │   │
│     └───────────────────────────────────────────────────────────────────┘   │
│                                                                              │
│  6. IDLE DETECTION                                                           │
│     ┌───────────────────────────────────────────────────────────────────┐   │
│     │ • Track last activity (keystrokes, commands)                      │   │
│     │ • After 30 min idle: call control plane or shutdown directly      │   │
│     └───────────────────────────────────────────────────────────────────┘   │
│                                                                              │
│  7. CREDENTIAL REFRESH (Future)                                              │
│     ┌───────────────────────────────────────────────────────────────────┐   │
│     │ • Periodically fetch fresh GitHub tokens from control plane       │   │
│     │ • Write to /var/secrets/github-token                              │   │
│     └───────────────────────────────────────────────────────────────────┘   │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Configuration

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                       VM AGENT CONFIGURATION                                 │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ENVIRONMENT VARIABLES (/etc/workspace/agent.env)                            │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │ WORKSPACE_ID=ws-abc123                                               │   │
│  │ CONTROL_PLANE_URL=https://api.workspaces.example.com                 │   │
│  │ JWKS_URL=https://api.workspaces.example.com/.well-known/jwks.json    │   │
│  │ LISTEN_ADDR=:443                                                     │   │
│  │ TLS_CERT=/etc/ssl/cert.pem                                           │   │
│  │ TLS_KEY=/etc/ssl/key.pem                                             │   │
│  │ SESSION_SECRET=xxx                                                   │   │
│  │ DEVCONTAINER_WORKSPACE=/workspace                                    │   │
│  │ IDLE_TIMEOUT=30m                                                     │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## GitHub Authentication

### Option Comparison

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    GITHUB AUTHENTICATION OPTIONS                             │
├───────────────┬─────────────┬─────────────────┬─────────────────────────────┤
│               │ GitHub App  │ Personal Access │ OAuth Device                │
│               │ (Tier 2)    │ Token (MVP)     │ Flow (Alt)                  │
├───────────────┼─────────────┼─────────────────┼─────────────────────────────┤
│ Security      │ ★★★★★       │ ★★★☆☆           │ ★★★★☆                       │
│ Ease of Setup │ ★★★☆☆       │ ★★★★★           │ ★★★★☆                       │
│ Token Lifetime│ 1 hour      │ User-defined    │ 8 hours                     │
│ Scope Control │ Fine-grained│ Broad           │ Fine-grained                │
│ User Action   │ Install App │ Paste token     │ Visit URL + code            │
│ Refresh       │ Automatic   │ Manual          │ Automatic                   │
│ Audit Trail   │ App-level   │ User-level      │ User-level                  │
└───────────────┴─────────────┴─────────────────┴─────────────────────────────┘
```

### GitHub App Flow (Recommended - Tier 2)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                      GITHUB APP AUTHENTICATION FLOW                          │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ONE-TIME SETUP (User installs our GitHub App)                               │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │                                                                        │ │
│  │   User          Our UI           GitHub                                │ │
│  │     │              │                │                                  │ │
│  │     │─ "Connect"──►│                │                                  │ │
│  │     │              │─ Redirect ────►│                                  │ │
│  │     │              │                │                                  │ │
│  │     │◄────────────────"Install App"─│                                  │ │
│  │     │              │                │                                  │ │
│  │     │─ Select repos ───────────────►│                                  │ │
│  │     │◄───────────── Installation ID─│                                  │ │
│  │     │              │                │                                  │ │
│  │     │              │◄─ Callback ────│                                  │ │
│  │     │              │  installation_id                                  │ │
│  │     │◄─ "Connected"│                │                                  │ │
│  │                                                                        │ │
│  │   Result: We store installation_id for this user                       │ │
│  │                                                                        │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
│                                                                              │
│  WORKSPACE CREATION (Generate short-lived token)                             │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │                                                                        │ │
│  │   Our API                      GitHub API                              │ │
│  │      │                             │                                   │ │
│  │      │  1. Generate JWT            │                                   │ │
│  │      │     (App ID + Private Key)  │                                   │ │
│  │      │                             │                                   │ │
│  │      │──POST /app/installations/───►│                                  │ │
│  │      │      {id}/access_tokens     │                                   │ │
│  │      │   Authorization: Bearer JWT │                                   │ │
│  │      │   Body: { repositories: ... }                                   │ │
│  │      │                             │                                   │ │
│  │      │◄────── Installation Token ──│                                   │ │
│  │      │        (expires in 1 hour)  │                                   │ │
│  │      │                             │                                   │ │
│  │      │  2. Pass token to VM        │                                   │ │
│  │      │     via cloud-init          │                                   │ │
│  │                                                                        │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
│                                                                              │
│  TOKEN REFRESH (Automatic, every 45 minutes)                                 │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │                                                                        │ │
│  │   VM (cron)           Our API              GitHub API                  │ │
│  │      │                    │                    │                       │ │
│  │      │─GET /workspaces/──►│                    │                       │ │
│  │      │   {id}/credentials │                    │                       │ │
│  │      │   Auth: workspace-token                 │                       │ │
│  │      │                    │                    │                       │ │
│  │      │                    │──POST /app/inst/──►│                       │ │
│  │      │                    │   access_tokens    │                       │ │
│  │      │                    │◄── Fresh token ────│                       │ │
│  │      │                    │                    │                       │ │
│  │      │◄── Fresh token ────│                    │                       │ │
│  │      │                    │                    │                       │ │
│  │      │  Update /var/secrets/github-token       │                       │ │
│  │                                                                        │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Personal Access Token Flow (MVP)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         PAT AUTHENTICATION FLOW (MVP)                        │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   User             Web UI              API               VM                  │
│     │                 │                  │                 │                 │
│     │─ "New Workspace"►                  │                 │                 │
│     │                 │                  │                 │                 │
│     │◄─ "Enter PAT   │                  │                 │                 │
│     │    (optional)" │                  │                 │                 │
│     │                 │                  │                 │                 │
│     │─ Repo URL ─────►│                  │                 │                 │
│     │  + PAT          │                  │                 │                 │
│     │                 │                  │                 │                 │
│     │                 │─ POST /vms ─────►│                 │                 │
│     │                 │  { repo, pat }   │                 │                 │
│     │                 │                  │                 │                 │
│     │                 │                  │─ Create VM ────►│                 │
│     │                 │                  │  (cloud-init    │                 │
│     │                 │                  │   includes PAT) │                 │
│     │                 │                  │                 │                 │
│     │                 │                  │◄─ VM Ready ─────│                 │
│     │                 │                  │                 │                 │
│     │                 │◄─ { url, pass }──│                 │                 │
│     │                 │                  │                 │                 │
│     │◄─ "Open Terminal"                  │                 │                 │
│     │   + password    │                  │                 │                 │
│                                                                              │
│   SECURITY NOTES:                                                            │
│   • PAT transmitted over HTTPS only                                          │
│   • PAT never stored in our database (passed directly to VM)                 │
│   • PAT stored in /var/secrets with 600 permissions                          │
│   • PAT cleared from cloud-init user-data after first boot                   │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Git Credential Helper Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    GIT CREDENTIAL HELPER ARCHITECTURE                        │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   INSIDE DEVCONTAINER                                                        │
│   ┌──────────────────────────────────────────────────────────────────────┐  │
│   │                                                                      │  │
│   │   ~/.gitconfig                                                       │  │
│   │   ┌────────────────────────────────────────────────────────────────┐│  │
│   │   │ [credential]                                                   ││  │
│   │   │     helper = !f() {                                            ││  │
│   │   │         echo "protocol=https"                                  ││  │
│   │   │         echo "host=github.com"                                 ││  │
│   │   │         echo "username=x-access-token"                         ││  │
│   │   │         echo "password=$(cat /secrets/github-token)"           ││  │
│   │   │     }; f                                                       ││  │
│   │   └────────────────────────────────────────────────────────────────┘│  │
│   │                                                                      │  │
│   │   /secrets/ (mounted read-only from host)                            │  │
│   │   ┌────────────────────────────────────────────────────────────────┐│  │
│   │   │ github-token   (contains PAT or installation token)            ││  │
│   │   └────────────────────────────────────────────────────────────────┘│  │
│   │                                                                      │  │
│   └──────────────────────────────────────────────────────────────────────┘  │
│                                                                              │
│   FLOW                                                                       │
│   ┌──────────────────────────────────────────────────────────────────────┐  │
│   │                                                                      │  │
│   │   $ git push                                                         │  │
│   │       │                                                              │  │
│   │       ▼                                                              │  │
│   │   git: "need credentials for https://github.com"                     │  │
│   │       │                                                              │  │
│   │       ▼                                                              │  │
│   │   credential helper: reads /secrets/github-token                     │  │
│   │       │                                                              │  │
│   │       ▼                                                              │  │
│   │   git: uses token as password with username "x-access-token"         │  │
│   │       │                                                              │  │
│   │       ▼                                                              │  │
│   │   GitHub: authenticates, push succeeds                               │  │
│   │                                                                      │  │
│   └──────────────────────────────────────────────────────────────────────┘  │
│                                                                              │
│   WHY THIS APPROACH?                                                         │
│   • Token never stored in git config or commit history                       │
│   • Token can be rotated without changing git config                         │
│   • Token file has strict permissions (600)                                  │
│   • Works with both PATs and installation tokens                             │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Component Deep Dive

### ttyd Configuration

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           ttyd COMPONENT DETAILS                             │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   WHAT IT IS                                                                 │
│   • Lightweight terminal server written in C                                 │
│   • Uses libwebsockets for WebSocket communication                           │
│   • Uses xterm.js for browser-side rendering                                 │
│   • ~43MB Docker image (alpine-based)                                        │
│                                                                              │
│   HOW IT WORKS                                                               │
│   ┌──────────────────────────────────────────────────────────────────────┐  │
│   │                                                                      │  │
│   │   Browser                    ttyd                    Shell           │  │
│   │      │                         │                       │             │  │
│   │      │── HTTP GET / ──────────►│                       │             │  │
│   │      │◄── HTML + xterm.js ─────│                       │             │  │
│   │      │                         │                       │             │  │
│   │      │── WebSocket Upgrade ───►│                       │             │  │
│   │      │◄── 101 Switching ───────│                       │             │  │
│   │      │                         │                       │             │  │
│   │      │                         │── fork + exec ───────►│             │  │
│   │      │                         │   (pseudo-terminal)   │             │  │
│   │      │                         │                       │             │  │
│   │      │◄─── stdout ─────────────│◄────── output ────────│             │  │
│   │      │                         │                       │             │  │
│   │      │──── keystrokes ────────►│─────── stdin ────────►│             │  │
│   │      │                         │                       │             │  │
│   │      │◄─── resize event ───────│   (SIGWINCH)          │             │  │
│   │                                                                      │  │
│   └──────────────────────────────────────────────────────────────────────┘  │
│                                                                              │
│   KEY OPTIONS                                                                │
│   ┌────────────────────┬─────────────────────────────────────────────────┐  │
│   │ --credential u:p   │ Basic authentication                            │  │
│   │ --port 7681        │ Listen port                                     │  │
│   │ --interface 0.0.0.0│ Bind address                                    │  │
│   │ --check-origin     │ Prevent cross-origin WebSocket                  │  │
│   │ --max-clients N    │ Limit concurrent sessions                       │  │
│   │ --auth-header HDR  │ Trust reverse proxy auth header                 │  │
│   │ --ssl              │ Enable TLS (usually handled by CF)              │  │
│   │ --ping-interval N  │ WebSocket keepalive                             │  │
│   └────────────────────┴─────────────────────────────────────────────────┘  │
│                                                                              │
│   OUR USAGE                                                                  │
│   ┌──────────────────────────────────────────────────────────────────────┐  │
│   │ ttyd \                                                               │  │
│   │   --port 7681 \                                                      │  │
│   │   --credential "workspace:${TERMINAL_PASSWORD}" \                    │  │
│   │   --check-origin \                                                   │  │
│   │   --max-clients 3 \                                                  │  │
│   │   --ping-interval 30 \                                               │  │
│   │   devcontainer exec --workspace-folder /workspace bash               │  │
│   └──────────────────────────────────────────────────────────────────────┘  │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Cloud-Init Sequence

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         CLOUD-INIT BOOT SEQUENCE                             │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   VM BOOT                                                                    │
│       │                                                                      │
│       ▼                                                                      │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │ 1. NETWORK SETUP (cloud-init network stage)                         │   │
│   │    • Configure networking                                           │   │
│   │    • Set hostname: ws-{id}                                          │   │
│   └───────────────────────────────────┬─────────────────────────────────┘   │
│                                       ▼                                      │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │ 2. SECRETS SETUP (cloud-init config stage)                          │   │
│   │    • Create /var/secrets directory (700)                            │   │
│   │    • Write workspace-token (600)                                    │   │
│   │    • Write github-token (600)                                       │   │
│   │    • Generate and write terminal-pass (600)                         │   │
│   └───────────────────────────────────┬─────────────────────────────────┘   │
│                                       ▼                                      │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │ 3. PACKAGE INSTALLATION (cloud-init config stage)                   │   │
│   │    • Install Docker                                                 │   │
│   │    • Install ttyd                                                   │   │
│   │    • Install devcontainer CLI                                       │   │
│   └───────────────────────────────────┬─────────────────────────────────┘   │
│                                       ▼                                      │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │ 4. REPOSITORY SETUP (cloud-init final stage)                        │   │
│   │    • Clone repository to /workspace                                 │   │
│   │    • Configure git credential helper                                │   │
│   └───────────────────────────────────┬─────────────────────────────────┘   │
│                                       ▼                                      │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │ 5. DEVCONTAINER SETUP (cloud-init final stage)                      │   │
│   │    • devcontainer up --workspace-folder /workspace                  │   │
│   │    • Wait for container to be ready                                 │   │
│   └───────────────────────────────────┬─────────────────────────────────┘   │
│                                       ▼                                      │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │ 6. SERVICES START (cloud-init final stage)                          │   │
│   │    • Start ttyd (systemd service)                                   │   │
│   │    • Start idle-detector (systemd service)                          │   │
│   │    • Start credential-refresh (systemd timer)                       │   │
│   └───────────────────────────────────┬─────────────────────────────────┘   │
│                                       ▼                                      │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │ 7. READY CALLBACK (cloud-init final stage)                          │   │
│   │    • POST to API: /workspaces/{id}/ready                            │   │
│   │    • Include: status, ip, errors (if any)                           │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
│   TIMING (approximate)                                                       │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │ Network setup:      ~10s                                            │   │
│   │ Package install:    ~60s (Docker, ttyd, devcontainer CLI)           │   │
│   │ Repo clone:         ~10-30s (depends on size)                       │   │
│   │ Devcontainer build: ~60-300s (depends on Dockerfile)                │   │
│   │ ─────────────────────────────────────                               │   │
│   │ Total:              ~2-6 minutes                                    │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Sequence Diagrams

### Complete Workspace Creation Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    WORKSPACE CREATION SEQUENCE                               │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│ User        Web UI        API         Hetzner      Cloudflare      VM       │
│   │            │            │            │             │            │        │
│   │─"Create"──►│            │            │             │            │        │
│   │            │            │            │             │            │        │
│   │◄──Form─────│            │            │             │            │        │
│   │            │            │            │             │            │        │
│   │─Repo+PAT──►│            │            │             │            │        │
│   │            │            │            │             │            │        │
│   │            │──POST /vms►│            │             │            │        │
│   │            │            │            │             │            │        │
│   │            │            │──Create────►│            │            │        │
│   │            │            │   Server    │            │            │        │
│   │            │            │◄──Server ID─│            │            │        │
│   │            │            │   + IP      │            │            │        │
│   │            │            │            │             │            │        │
│   │            │            │─────────────────Create───►│            │        │
│   │            │            │                DNS A      │            │        │
│   │            │            │◄────────────────OK────────│            │        │
│   │            │            │            │             │            │        │
│   │            │◄─202 {id}──│            │             │            │        │
│   │            │   url,pass │            │             │            │        │
│   │            │            │            │             │            │        │
│   │◄─"Creating"│            │            │             │            │        │
│   │  (polling) │            │            │             │            │        │
│   │            │            │            │             │            │        │
│   │            │            │            │             │      ┌─────┤        │
│   │            │            │            │             │      │BOOT │        │
│   │            │            │            │             │      │     │        │
│   │            │            │            │             │      │cloud│        │
│   │            │            │            │             │      │-init│        │
│   │            │            │            │             │      │     │        │
│   │            │            │            │             │      │setup│        │
│   │            │            │            │             │      └─────┤        │
│   │            │            │            │             │            │        │
│   │            │            │◄────────────────────────POST /ready───│        │
│   │            │            │                                       │        │
│   │            │◄─GET /vms/{id}                                     │        │
│   │            │  (poll)    │                                       │        │
│   │            │            │                                       │        │
│   │            │◄─{status:  │                                       │        │
│   │            │  "ready"}  │                                       │        │
│   │            │            │                                       │        │
│   │◄─"Ready!   │            │                                       │        │
│   │  Open Term"│            │                                       │        │
│   │            │            │                                       │        │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Terminal Session Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                      TERMINAL SESSION SEQUENCE                               │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│ Browser      Cloudflare       ttyd        devcontainer      bash            │
│    │              │             │               │             │              │
│    │──GET /──────►│             │               │             │              │
│    │              │──GET /─────►│               │             │              │
│    │              │◄─401────────│               │             │              │
│    │◄─401─────────│             │               │             │              │
│    │              │             │               │             │              │
│    │  (browser prompts for credentials)        │             │              │
│    │              │             │               │             │              │
│    │──GET /──────►│             │               │             │              │
│    │  Auth: Basic │             │               │             │              │
│    │              │──GET /─────►│               │             │              │
│    │              │  Auth: Basic│               │             │              │
│    │              │             │               │             │              │
│    │              │◄─200 HTML───│               │             │              │
│    │◄─200 HTML────│  + xterm.js │               │             │              │
│    │              │             │               │             │              │
│    │  (xterm.js loads and initializes)         │             │              │
│    │              │             │               │             │              │
│    │──WS Upgrade─►│             │               │             │              │
│    │              │──WS Upgrade►│               │             │              │
│    │              │◄─101────────│               │             │              │
│    │◄─101─────────│             │               │             │              │
│    │              │             │               │             │              │
│    │              │             │──exec────────►│             │              │
│    │              │             │               │──bash──────►│              │
│    │              │             │               │             │              │
│    │◄─────────────────────────────────────────────────prompt──│              │
│    │              │             │               │             │              │
│    │──"ls -la"───►│             │               │             │              │
│    │              │─────────────►│──────────────►│─────────────►│             │
│    │              │             │               │             │              │
│    │◄──────────────────────────────────────────────────output─│              │
│    │              │             │               │             │              │
│    │  ... interactive session continues ...    │             │              │
│    │              │             │               │             │              │
│    │──(close tab)─│             │               │             │              │
│    │              │──WS Close──►│               │             │              │
│    │              │             │──SIGHUP──────►│─────────────►│             │
│    │              │             │               │             │ (exit)       │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Token Refresh Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                       TOKEN REFRESH SEQUENCE                                 │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  VM (cron)           API              GitHub API                            │
│     │                  │                   │                                 │
│     │  (every 45 min)  │                   │                                 │
│     │                  │                   │                                 │
│     │──GET /workspace/ │                   │                                 │
│     │   {id}/creds     │                   │                                 │
│     │   Auth: ws-token │                   │                                 │
│     │                  │                   │                                 │
│     │                  │──Verify token─────│                                 │
│     │                  │                   │                                 │
│     │                  │──Generate JWT─────│                                 │
│     │                  │  (App key)        │                                 │
│     │                  │                   │                                 │
│     │                  │──POST /app/inst/──►│                                │
│     │                  │   access_tokens   │                                 │
│     │                  │                   │                                 │
│     │                  │◄──New token───────│                                 │
│     │                  │   (1 hr expiry)   │                                 │
│     │                  │                   │                                 │
│     │◄─{github_token}──│                   │                                 │
│     │                  │                   │                                 │
│     │  Write to        │                   │                                 │
│     │  /var/secrets/   │                   │                                 │
│     │  github-token    │                   │                                 │
│     │                  │                   │                                 │
│     │  (next git op    │                   │                                 │
│     │   uses new token)│                   │                                 │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Development Workflow

> **No complex local testing** - Deploy to Cloudflare staging environment and iterate there.

### Why No Local Testing?

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    WHY CLOUDFLARE-FIRST DEVELOPMENT                          │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  LOCAL TESTING PROBLEMS                                                      │
│  • Too many moving pieces (API, VM Agent, ttyd, Web UI)                     │
│  • Docker-in-Docker doesn't work in devcontainers                           │
│  • OAuth requires real callback URLs                                         │
│  • D1/KV can't be fully simulated locally                                   │
│  • DNS-based routing hard to mock                                            │
│                                                                              │
│  CLOUDFLARE STAGING BENEFITS                                                 │
│  • Real D1, KV, Workers - no mocking                                        │
│  • Real OAuth flow with staging callback URL                                │
│  • Fast deploys (< 30 seconds)                                              │
│  • Free tier covers development                                             │
│  • Identical to production                                                  │
│  • Wrangler tail for real-time logs                                         │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Development Commands

```bash
# First-time setup (once per developer)
pnpm setup

# Deploy to staging (fast iteration)
pnpm deploy:staging

# View real-time logs
pnpm --filter @workspaces/api wrangler tail --env staging

# Run database migrations
pnpm --filter @workspaces/api db:migrate:staging

# Deploy to production
pnpm deploy

# Tear down staging (clean slate)
pnpm teardown:staging
```

### Staging Environment

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                       STAGING ENVIRONMENT                                    │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  URLs                                                                        │
│  • Web UI:  https://staging.workspaces.example.com                          │
│  • API:     https://api-staging.workspaces.example.com                      │
│  • GitHub callback: https://api-staging.workspaces.example.com/api/auth/    │
│                     callback/github                                          │
│                                                                              │
│  Resources (separate from production)                                        │
│  • D1 Database: workspaces-staging                                          │
│  • KV Namespace: KV_STAGING                                                 │
│  • Worker: workspaces-api-staging                                           │
│  • Pages Project: workspaces-staging                                        │
│                                                                              │
│  Secrets (same structure, different values)                                  │
│  • GITHUB_CLIENT_ID (staging OAuth app)                                     │
│  • GITHUB_CLIENT_SECRET                                                     │
│  • JWT keys, encryption key                                                 │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Typical Development Cycle

```
1. Make code changes locally
2. Run `pnpm deploy:staging` (30 seconds)
3. Test in browser at staging URL
4. Check logs with `wrangler tail --env staging`
5. Repeat until working
6. Create PR
7. Merge → auto-deploy to production
```

### Unit Testing (Local)

For logic that doesn't need Cloudflare services, run unit tests locally:

```bash
# Run all tests
pnpm test

# Run specific package tests
pnpm --filter @workspaces/api test
pnpm --filter @workspaces/web test
```

Tests mock Cloudflare bindings using `miniflare` for Workers logic.

---

## Implementation Tiers

### Tier 1: Core Platform (Implement Now)

**No shortcuts** - Build proper auth and multi-tenancy from the start.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         TIER 1: CORE PLATFORM                                │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  USER AUTHENTICATION (BetterAuth + GitHub OAuth)                             │
│  • GitHub OAuth via BetterAuth - no email/password                           │
│  • Session management with Cloudflare KV                                     │
│  • Rate limiting built-in                                                    │
│                                                                              │
│  MULTI-TENANT MODEL                                                          │
│  • Users bring their own Hetzner API token                                   │
│  • Tokens encrypted with AES-GCM in D1                                       │
│  • VMs created on user's Hetzner account                                     │
│  • We manage: auth, workspace metadata, DNS, orchestration                   │
│                                                                              │
│  TERMINAL AUTHENTICATION (JWT)                                               │
│  • Control plane issues JWTs for terminal access                             │
│  • JWKS endpoint at /.well-known/jwks.json                                   │
│  • VM Agent validates JWTs and proxies to ttyd                               │
│                                                                              │
│  GIT AUTHENTICATION                                                          │
│  • User provides PAT for private repos                                       │
│  • PAT passed to VM via cloud-init                                           │
│  • Git credential helper reads from secrets file                             │
│                                                                              │
│  ARCHITECTURE                                                                │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │                                                                       │  │
│  │  Browser → GitHub OAuth → Control Plane → Hetzner (user's account)   │  │
│  │                              ↓                                        │  │
│  │                         Issue JWT                                     │  │
│  │                              ↓                                        │  │
│  │                    VM Agent → ttyd → devcontainer                     │  │
│  │                                                                       │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                                                                              │
│  CLOUDFLARE STACK                                                            │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │ • Pages: React web UI                                                 │  │
│  │ • Workers: Hono API + BetterAuth                                      │  │
│  │ • D1: Users, credentials, workspaces                                  │  │
│  │ • KV: Sessions, rate limiting                                         │  │
│  │ • DNS: Workspace subdomains                                           │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                                                                              │
│  FEATURES                                                                    │
│  ✓ GitHub OAuth login                                                        │
│  ✓ User brings own Hetzner token                                             │
│  ✓ Browser-based terminal                                                    │
│  ✓ JWT-based terminal auth                                                   │
│  ✓ Devcontainer support                                                      │
│  ✓ Git operations (with PAT)                                                 │
│  ✓ Claude Code CLI available                                                 │
│  ✓ Easy deploy/teardown                                                      │
│                                                                              │
│  DEFERRED TO TIER 2                                                          │
│  • GitHub App (fine-grained repo tokens)                                     │
│  • Token refresh                                                             │
│  • Idle detection (integrated in VM Agent)                                   │
│  • Usage analytics                                                           │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Tier 2: Enhanced Features (Next Phase)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        TIER 2: ENHANCED FEATURES                             │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  GITHUB APP INTEGRATION                                                      │
│  • Users install our GitHub App for fine-grained access                      │
│  • Short-lived installation tokens (1 hour)                                  │
│  • VM Agent handles automatic token refresh                                  │
│  • No PAT needed for repos where App is installed                            │
│                                                                              │
│  VM AGENT ENHANCEMENTS                                                       │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │ • Idle detection: shutdown VM after 30min inactivity                  │  │
│  │ • Credential refresh: fetch new GitHub tokens automatically           │  │
│  │ • Metrics: report uptime, activity to control plane                   │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                                                                              │
│  ADDITIONAL CLOUD PROVIDERS                                                  │
│  • AWS EC2 support                                                           │
│  • GCP Compute Engine support                                                │
│  • User can choose where to run workspaces                                   │
│                                                                              │
│  BILLING & USAGE                                                             │
│  • Track workspace usage time                                                │
│  • Show estimated costs from cloud provider                                  │
│  • Usage dashboards                                                          │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Tier 3: Enterprise (Future)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          TIER 3: ENTERPRISE                                  │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  AUTHENTICATION                                                              │
│  • SAML/OIDC SSO integration                                                 │
│  • mTLS between all components                                               │
│  • Service tokens for CI/CD integration                                      │
│                                                                              │
│  GITHUB AUTH                                                                 │
│  • GitHub Enterprise Server support                                          │
│  • Organization-wide GitHub App                                              │
│  • Audit trail for all token operations                                      │
│                                                                              │
│  ADDITIONAL FEATURES                                                         │
│  • Session recording/replay                                                  │
│  • Compliance logging (SOC2, etc.)                                           │
│  • Network isolation per workspace                                           │
│  • Custom VM images                                                          │
│  • Secrets management integration (Vault, etc.)                              │
│  • Multiple cloud providers                                                  │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Resources

### Official Documentation

- [ttyd GitHub](https://github.com/tsl0922/ttyd) - Terminal server
- [xterm.js](https://xtermjs.org/) - Browser terminal emulator
- [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/access-controls/) - Zero trust auth
- [Cloudflare Service Tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/) - Programmatic access
- [GitHub Apps](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app) - Installation tokens
- [Devcontainer Features](https://github.com/anthropics/devcontainer-features) - Claude Code feature
- [VS Code Git Credentials](https://code.visualstudio.com/remote/advancedcontainers/sharing-git-credentials) - Credential sharing

### Related Projects

- [Portainer](https://www.portainer.io/) - Uses xterm.js for container terminals
- [Gitpod](https://www.gitpod.io/) - Cloud dev environments
- [GitHub Codespaces](https://github.com/features/codespaces) - Similar architecture

### Security Best Practices

- [GitHub App Best Practices](https://docs.github.com/en/apps/creating-github-apps/about-creating-github-apps/best-practices-for-creating-a-github-app)
- [Cloudflare Access Policies](https://developers.cloudflare.com/reference-architecture/design-guides/designing-ztna-access-policies/)
- [Container Security](https://cheatsheetseries.owasp.org/cheatsheets/Docker_Security_Cheat_Sheet.html)

---

## Summary

This architecture provides a multi-tenant SaaS platform where users bring their own Hetzner accounts to run cloud development environments.

### Core Stack

1. **BetterAuth + GitHub OAuth** for user authentication
2. **Cloudflare D1/KV/Workers/Pages** for control plane
3. **JWT-based terminal auth** with JWKS endpoint
4. **VM Agent** (Go binary) for auth, proxy, and lifecycle
5. **ttyd + devcontainer** for the actual terminal environment
6. **Single-command deploy/teardown** via Wrangler scripts

### Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| GitHub OAuth from day 1 | No shortcuts - proper auth matters |
| BetterAuth | Cloudflare-native, handles sessions, rate limiting |
| User brings Hetzner key | Multi-tenant without us managing cloud accounts |
| Cloudflare-first dev | Iterate on staging, not complex local setup |
| VM Agent in Go | Single binary, no runtime deps, extensible |
| JWT + JWKS | Standard protocol, key rotation, stateless validation |

### Component Summary

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         COMPONENT SUMMARY                                    │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  CLOUDFLARE PAGES (Web UI)                                                   │
│  • React + Vite application                                                  │
│  • BetterAuth React client                                                   │
│  • Dashboard, settings, workspace management                                 │
│                                                                              │
│  CLOUDFLARE WORKER (API)                                                     │
│  • Hono API framework                                                        │
│  • BetterAuth for GitHub OAuth                                               │
│  • Issues JWTs for terminal access                                           │
│  • Exposes JWKS at /.well-known/jwks.json                                    │
│  • Orchestrates Hetzner VMs                                                  │
│  • Manages Cloudflare DNS records                                            │
│                                                                              │
│  CLOUDFLARE D1 (Database)                                                    │
│  • Users, sessions (BetterAuth)                                              │
│  • Encrypted cloud credentials                                               │
│  • Workspace metadata                                                        │
│                                                                              │
│  CLOUDFLARE KV (Key-Value)                                                   │
│  • Session storage                                                           │
│  • Rate limiting                                                             │
│  • JWKS cache                                                                │
│                                                                              │
│  VM AGENT (Single Go binary on each VM - no Docker)                          │
│  • Serves embedded React UI with xterm.js                                    │
│  • Manages PTY sessions directly (via creack/pty)                            │
│  • Validates JWTs against JWKS                                               │
│  • WebSocket terminal I/O                                                    │
│  • Executes: devcontainer exec --workspace-folder /workspace bash            │
│  • Idle detection, health endpoints                                          │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Quick Start

```bash
# First time setup (creates GitHub OAuth app, sets secrets)
pnpm setup

# Deploy everything
pnpm deploy

# Iterate on staging
pnpm deploy:staging

# View logs
pnpm --filter @workspaces/api wrangler tail --env staging

# Tear down
pnpm teardown:staging
```

The platform is designed for rapid iteration on Cloudflare's infrastructure with proper auth and multi-tenancy from day one.
