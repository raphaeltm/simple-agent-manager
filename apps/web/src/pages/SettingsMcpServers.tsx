/**
 * Personal MCP servers.
 *
 * Deliberately NOT named "Connections": that word already means composable-credential
 * connections in SAM (Settings -> Connections manages LLM and cloud provider credentials).
 * "MCP servers" is also the vocabulary users already know from Claude Code, Codex and Cursor.
 */
import { McpServersManager } from '../components/mcp-servers/McpServersManager';
import { useQueryScope } from '../hooks/useQueryScope';

export function SettingsMcpServers() {
  const queryScope = useQueryScope();

  return (
    <div className="w-full min-w-0 space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-fg-primary">MCP servers</h2>
        <p className="mt-1 text-sm text-fg-muted break-words">
          Give your agents access to third-party services. Connect a provider in their own
          dashboard, then paste the MCP endpoint they give you — SAM passes it to every agent
          session alongside its own tools.
        </p>
      </div>

      <McpServersManager projectId={null} queryScope={queryScope} title={null} />

      <div className="rounded-md border border-border-default bg-surface p-3">
        <h3 className="text-sm font-medium text-fg-primary">Where do I get an MCP endpoint?</h3>
        <ul className="mt-2 space-y-1 text-xs text-fg-muted">
          <li>
            <strong className="text-fg-primary">Zapier MCP</strong> — broadest catalog (~9,000 apps).
            Do the OAuth in Zapier, copy the endpoint and its bearer token.
          </li>
          <li>
            <strong className="text-fg-primary">executor.sh</strong> — open source (MIT); run it
            yourself or use their hosted endpoint.
          </li>
          <li>
            <strong className="text-fg-primary">Composio / Rube</strong> — issues a pre-signed URL, so
            choose &ldquo;None&rdquo; for authentication.
          </li>
          <li>
            <strong className="text-fg-primary">Official service endpoints</strong> — GitHub, Notion,
            Linear, Sentry and Stripe all publish remote MCP servers that take a personal
            access token as the bearer.
          </li>
        </ul>
        <p className="mt-2 text-xs text-fg-muted break-words">
          Tools from an MCP server run with your agent&apos;s full repository and shell access,
          and their descriptions enter the agent&apos;s context. Only add endpoints you trust.
        </p>
      </div>
    </div>
  );
}
