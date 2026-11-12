import { Body, Card } from '@simple-agent-manager/ui';
import type { FC } from 'react';

/** The commands deploy/selfhost/README.md ("Logs") documents for reading logs on the box. */
const BOX_LOG_COMMANDS = [
  'cd deploy/selfhost',
  'docker compose logs -f --since 30m celld          # Worker (API) logs, console.log and errors',
  'docker compose logs --since 30m caddy | grep http.log.access   # redacted request log',
].join('\n');

/**
 * Shown on Admin → Logs and Admin → Stream on an installation without Cloudflare log search or
 * a tail worker (self-host). Errors SAM records itself still appear on Admin → Errors.
 */
export const BoxLogsNotice: FC<{ surface: 'search' | 'stream' }> = ({ surface }) => (
  <Card>
    <div className="p-4 flex flex-col gap-3" data-testid="box-logs-notice">
      <Body>
        {surface === 'stream'
          ? 'The live log stream is not available on this installation.'
          : 'Log search is not available on this installation.'}{' '}
        Request and runtime logs stay on the server. Read them there over SSH:
      </Body>
      <pre className="text-xs bg-inset rounded-sm p-3 overflow-x-auto whitespace-pre">
        {BOX_LOG_COMMANDS}
      </pre>
      <Body>Errors that SAM records itself are listed on the Errors tab.</Body>
    </div>
  </Card>
);
