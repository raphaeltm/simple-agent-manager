/**
 * MCP tool handler: get_compose_publish_instructions
 *
 * Tells the agent how to publish its project's compose stack WITHOUT ever
 * receiving a registry credential. Unlike get_registry_credentials (which mints
 * a short-lived push credential the agent uses directly), the compose-publish
 * path keeps the credential entirely inside the SAM-controlled vm-agent: the
 * agent runs native `docker compose publish` against the local OCI receiver
 * ($SAM_REGISTRY_PUBLISH_HOST), and the receiver mints the scoped credential and
 * re-pushes the built service images into the project namespace on the agent's
 * behalf.
 *
 * This handler returns ONLY guidance — no secrets. It is gated behind the same
 * phase-D project-level agent-deploy policy as the rest of the publish path.
 */
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../../db/schema';
import type { Env } from '../../env';
import { isProjectAgentDeployEnabled } from '../../services/deployment-control';
import {
  INVALID_PARAMS,
  jsonRpcError,
  type JsonRpcResponse,
  jsonRpcSuccess,
  type McpTokenData,
} from './_helpers';

/**
 * Handle the get_compose_publish_instructions MCP tool call.
 *
 * No rate limiting: this handler reads policy state and returns static guidance
 * — it mints nothing and touches no upstream API. The credential mint + release
 * ingestion that the receiver triggers downstream are themselves rate-limited.
 */
export async function handleGetComposePublishInstructions(
  _requestId: string | number | null,
  _toolArgs: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env,
): Promise<JsonRpcResponse> {
  const { projectId } = tokenData;
  const db = drizzle(env.DATABASE, { schema });

  const deployEnabled = await isProjectAgentDeployEnabled(db, projectId);
  if (!deployEnabled) {
    return jsonRpcError(
      _requestId,
      INVALID_PARAMS,
      'Agent deployment is disabled for this project. Ask the project owner to enable agent deployment on a deployment environment before publishing.',
    );
  }

  // Static guidance. The receiver hostname lives in the workspace env as
  // $SAM_REGISTRY_PUBLISH_HOST (set by the vm-agent when the receiver is
  // serving); we reference the variable rather than hardcoding the host so the
  // instructions stay correct if the receiver address changes.
  const instructions = [
    'Publish your compose stack so SAM can capture and re-push your built images. Do NOT request raw registry credentials — the SAM workspace agent handles credentials for you.',
    'Step 1. Confirm the publish target is set: `echo "$SAM_REGISTRY_PUBLISH_HOST"` (this is the local SAM OCI receiver — all published images route through it).',
    'Step 2. From your project directory (where compose.yaml lives), run: `docker compose publish "$SAM_REGISTRY_PUBLISH_HOST/<project-name>"` — built services are pushed to the receiver; pre-built upstream images (e.g. redis:7) stay on their public registry.',
    'Step 3. The SAM workspace agent captures the published artifact, re-pushes the built service images into your project-scoped registry namespace, and records a deployment release. You do not need to authenticate to any registry or upload images yourself — `docker compose publish` against the receiver is the only command you run.',
    'Step 4. If publish fails, ensure all buildable services define a `build:` section and that the stack builds cleanly with `docker compose build` first.',
  ];

  return jsonRpcSuccess(_requestId, {
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          {
            publishHostEnvVar: 'SAM_REGISTRY_PUBLISH_HOST',
            requestRawCredentials: false,
            instructions,
          },
          null,
          2,
        ),
      },
    ],
  });
}
