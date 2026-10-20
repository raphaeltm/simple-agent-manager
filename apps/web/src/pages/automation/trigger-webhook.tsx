/**
 * Everything a webhook automation needs on its page: how to connect the calling service (the
 * URL is always shown; the token only once, when created or rotated), a sample check that
 * starts nothing, and the delivery history.
 */
import {
  DEFAULT_WEBHOOK_DELIVERY_RETENTION_DAYS,
  type TriggerPreviewResponse,
  type TriggerResponse,
  type WebhookCredential,
  type WebhookDelivery,
} from '@simple-agent-manager/shared';
import { Button } from '@simple-agent-manager/ui';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Check, Copy, RotateCw } from 'lucide-react';
import { useState } from 'react';

import { ConfirmDialog } from '../../components/ConfirmDialog';
import { WebhookCredentialDialog } from '../../components/triggers/WebhookCredentialDialog';
import { useQueryScope } from '../../hooks/useQueryScope';
import { useToast } from '../../hooks/useToast';
import { previewWebhookTrigger, rotateWebhookTriggerToken } from '../../lib/api';
import { API_URL } from '../../lib/api/client';
import { webhookDeliveriesQueryOptions } from '../../lib/query-options';
import { useProjectContext } from '../ProjectContext';
import { deliveryText } from './describe';
import { useAutomationAction } from './detail-parts';
import { errorText } from './errors';
import { LoadError, Loading } from './page';
import { fullDate, relative } from './time';
import { OutcomeIcon, Panel, SectionTitle } from './ui';

/** The ingest endpoint is the same for every webhook: the API origin plus a fixed path. */
export const WEBHOOK_INGEST_URL = `${API_URL.replace(/\/$/, '')}/api/webhooks/ingest`;

const DEFAULT_SAMPLE = '{\n  "event": { "action": "created" }\n}';

function CopyButton({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  const toast = useToast();
  return (
    <button
      type="button"
      aria-label={`Copy ${label}`}
      onClick={() => {
        navigator.clipboard.writeText(value).then(
          () => setCopied(true),
          () => toast.error('Copy failed. Select the text and copy it instead.')
        );
      }}
      className="inline-flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded-md border border-border-default bg-transparent text-fg-primary hover:bg-surface-hover"
    >
      {copied ? <Check size={16} aria-hidden /> : <Copy size={16} aria-hidden />}
    </button>
  );
}

export function ConnectWebhook({
  trigger,
  canWrite,
}: {
  trigger: TriggerResponse;
  canWrite: boolean;
}) {
  const { projectId } = useProjectContext();
  const [confirmRotate, setConfirmRotate] = useState(false);
  const [credential, setCredential] = useState<WebhookCredential | null>(null);
  const rotate = useAutomationAction(() => rotateWebhookTriggerToken(projectId, trigger.id), {
    success: 'New token created. The old one has stopped working.',
    failure: 'Could not create a new token',
  });
  const endpoint = credential?.endpointUrl ?? WEBHOOK_INGEST_URL;
  const config = trigger.webhookConfig;
  return (
    <div className="flex flex-col gap-2">
      <SectionTitle
        title="Connect your service"
        hint="Paste these into the service that calls SAM"
      />
      <Panel className="flex flex-col gap-4 p-4 md:p-5" label="Webhook connection">
        <div className="flex flex-col gap-1.5">
          <span className="text-[13px] text-fg-muted">Webhook URL</span>
          <div className="flex items-center gap-2">
            <code
              className="min-w-0 flex-1 break-all rounded-md bg-inset px-3 py-2.5 text-[13px] text-fg-primary"
              data-testid="webhook-url"
            >
              {endpoint}
            </code>
            <CopyButton label="webhook URL" value={endpoint} />
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="text-[13px] text-fg-muted">Secret token</span>
          <span className="text-[15px] text-fg-primary">
            Ending in <span className="font-mono">••••{config?.tokenLastFour ?? '????'}</span>
            {config?.tokenRotatedAt
              ? ` · replaced ${relative(Date.parse(config.tokenRotatedAt))}`
              : config?.tokenCreatedAt
                ? ` · created ${relative(Date.parse(config.tokenCreatedAt))}`
                : ''}
          </span>
          <span className="text-[13px] text-fg-muted">
            Send it in the <span className="font-mono text-[12.5px]">Authorization</span> header as{' '}
            <span className="font-mono text-[12.5px]">Bearer &lt;token&gt;</span>. SAM cannot show
            it again; a new token replaces it right away.
          </span>
          {canWrite && (
            <Button
              variant="ghost"
              className="mt-1 w-fit"
              loading={rotate.isPending}
              onClick={() => setConfirmRotate(true)}
            >
              <RotateCw size={16} aria-hidden /> Get a new token
            </Button>
          )}
        </div>
      </Panel>
      <ConfirmDialog
        isOpen={confirmRotate}
        onClose={() => setConfirmRotate(false)}
        onConfirm={() => {
          setConfirmRotate(false);
          rotate.mutate(undefined, {
            onSuccess: (result) => setCredential(result.webhookCredential),
          });
        }}
        title="Replace the token?"
        message="The current token stops working immediately. Anything still using it will be refused until you paste in the new one."
        confirmLabel="Replace token"
        variant="warning"
        loading={rotate.isPending}
      />
      {credential && (
        <WebhookCredentialDialog credential={credential} onClose={() => setCredential(null)} />
      )}
    </div>
  );
}

function PreviewResult({ result }: { result: TriggerPreviewResponse }) {
  const filter = result.filterResult;
  const matched = filter ? filter.matched : true;
  return (
    <div
      className="flex gap-3 rounded-lg border border-border-default bg-inset p-3"
      role="status"
      data-testid="webhook-preview-result"
    >
      <OutcomeIcon outcome={matched ? 'ok' : 'ignored'} />
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <p className="m-0 text-sm font-semibold text-fg-primary">
          {matched ? 'Would start a chat' : 'Would not start a chat'}
        </p>
        {filter && (
          <p className="m-0 text-[13px] text-fg-muted [overflow-wrap:anywhere]">
            {filter.reason ?? `${filter.matchedFilters} of ${filter.totalFilters} filters matched.`}
          </p>
        )}
        {result.warnings.map((warning) => (
          <p key={warning} className="m-0 text-[13px] text-warning-fg [overflow-wrap:anywhere]">
            {warning}
          </p>
        ))}
        {matched && (
          <div className="flex flex-col gap-1">
            <span className="text-[13px] text-fg-muted">The chat would start with:</span>
            <pre className="m-0 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-surface px-3 py-2 text-[13px] text-fg-primary">
              {result.renderedPrompt}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}

/** Read-only for the API, so viewers may use it too. */
export function TryWebhook({ trigger }: { trigger: TriggerResponse }) {
  const { projectId } = useProjectContext();
  const [sample, setSample] = useState(DEFAULT_SAMPLE);
  const [result, setResult] = useState<TriggerPreviewResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const check = async () => {
    let payload: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(sample);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
      payload = parsed as Record<string, unknown>;
    } catch {
      setError('The sample must be a JSON object, like {"event": {"action": "created"}}.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      setResult(await previewWebhookTrigger(projectId, trigger.id, { payload }));
    } catch (cause) {
      setError(errorText(cause, 'The sample check failed'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col gap-2">
      <SectionTitle
        title="Try it with a sample"
        hint="See what would happen, without starting anything"
      />
      <Panel className="flex flex-col gap-3 p-4 md:p-5" label="Sample check">
        <label className="flex flex-col gap-1.5">
          <span className="text-[13px] text-fg-muted">Sample request body (JSON)</span>
          <textarea
            value={sample}
            onChange={(event) => setSample(event.target.value)}
            rows={7}
            spellCheck={false}
            className="font-mono text-[13px]"
          />
        </label>
        <Button variant="ghost" className="w-fit" loading={busy} onClick={() => void check()}>
          Check this sample
        </Button>
        {error && (
          <p role="alert" className="m-0 text-sm text-danger-fg [overflow-wrap:anywhere]">
            {error}
          </p>
        )}
        {result && !error && <PreviewResult result={result} />}
      </Panel>
    </div>
  );
}

/** What a call's linked run is: the run it started, or the record of the run it skipped. */
function deliveryRunText(outcome: WebhookDelivery['outcome']) {
  if (outcome === 'accepted') return 'Started a run';
  if (outcome === 'still_running' || outcome === 'concurrent_limit')
    return 'Recorded as a skipped run';
  return 'Linked to a run';
}

export function WebhookDeliveries({ trigger }: { trigger: TriggerResponse }) {
  const { projectId } = useProjectContext();
  const queryScope = useQueryScope();
  const deliveries = useInfiniteQuery({
    ...webhookDeliveriesQueryOptions(queryScope, projectId, trigger.id),
    enabled: Boolean(queryScope),
  });
  const list = deliveries.data?.pages.flatMap((page) => page.deliveries) ?? [];
  return (
    <div className="flex flex-col gap-2">
      <SectionTitle
        title="Calls received"
        hint={`Kept ${DEFAULT_WEBHOOK_DELIVERY_RETENTION_DAYS} days by default. A call can be accepted and still be ignored by the filters.`}
        action={
          <Button
            variant="ghost"
            loading={deliveries.isFetching && !deliveries.isFetchingNextPage}
            onClick={() => void deliveries.refetch()}
          >
            Refresh
          </Button>
        }
      />
      {deliveries.isError && list.length === 0 ? (
        <LoadError
          what="calls"
          error={deliveries.error}
          onRetry={() => void deliveries.refetch()}
        />
      ) : deliveries.isPending ? (
        <Loading label="Loading calls…" />
      ) : (
        <Panel className="overflow-hidden" label="Calls received">
          {list.length === 0 ? (
            <p className="m-0 p-4 text-sm text-fg-muted">No calls yet.</p>
          ) : (
            <ul className="m-0 list-none p-0">
              {list.map((delivery) => {
                const [outcome, text] = deliveryText(delivery.outcome);
                const received = Date.parse(delivery.receivedAt);
                return (
                  <li
                    key={delivery.id}
                    className="flex items-start gap-3 border-0 border-b border-solid border-border-default px-4 py-3 last:border-b-0"
                  >
                    <span className="pt-0.5">
                      <OutcomeIcon outcome={outcome} />
                    </span>
                    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="text-sm font-semibold text-fg-primary">{text}</span>
                      <span className="text-xs text-fg-muted" title={fullDate(received)}>
                        {relative(received)} ·{' '}
                        {delivery.outcome === 'processing'
                          ? 'in progress'
                          : `HTTP ${delivery.httpStatus}`}{' '}
                        · {delivery.bodyBytes} bytes
                      </span>
                      {delivery.errorCode && (
                        <span className="text-xs text-danger-fg [overflow-wrap:anywhere]">
                          Error code <code>{delivery.errorCode}</code>
                        </span>
                      )}
                      {delivery.executionId && (
                        <span
                          className="text-xs text-fg-muted"
                          title={`Run ID ${delivery.executionId}`}
                        >
                          {deliveryRunText(delivery.outcome)}, listed under Recent runs
                        </span>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Panel>
      )}
      {deliveries.hasNextPage && (
        <Button
          variant="ghost"
          className="w-fit"
          loading={deliveries.isFetchingNextPage}
          onClick={() => void deliveries.fetchNextPage()}
        >
          Show older calls
        </Button>
      )}
    </div>
  );
}
