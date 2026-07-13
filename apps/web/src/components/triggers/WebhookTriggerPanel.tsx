import type {
  TriggerPreviewResponse,
  TriggerResponse,
  WebhookCredential,
  WebhookDelivery,
} from '@simple-agent-manager/shared';
import { Button, Spinner } from '@simple-agent-manager/ui';
import { KeyRound, RotateCw, Send } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import { useToast } from '../../hooks/useToast';
import {
  listWebhookDeliveries,
  previewWebhookTrigger,
  rotateWebhookTriggerToken,
} from '../../lib/api';
import { WebhookCredentialDialog } from './WebhookCredentialDialog';

interface WebhookTriggerPanelProps {
  projectId: string;
  trigger: TriggerResponse;
  onRotated: () => void;
}

export function WebhookTriggerPanel({ projectId, trigger, onRotated }: WebhookTriggerPanelProps) {
  const toast = useToast();
  const [deliveries, setDeliveries] = useState<WebhookDelivery[]>([]);
  const [deliveriesLoading, setDeliveriesLoading] = useState(true);
  const [deliveriesLoadingMore, setDeliveriesLoadingMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [credential, setCredential] = useState<{
    value: WebhookCredential;
    returnFocusTarget: HTMLElement | null;
  } | null>(null);
  const [rotating, setRotating] = useState(false);
  const [sample, setSample] = useState('{\n  "event": { "action": "created" }\n}');
  const [preview, setPreview] = useState<TriggerPreviewResponse | null>(null);
  const [previewing, setPreviewing] = useState(false);

  const loadDeliveries = useCallback(
    async (cursor?: string) => {
      if (cursor) setDeliveriesLoadingMore(true);
      else setDeliveriesLoading(true);
      try {
        const response = await listWebhookDeliveries(projectId, trigger.id, cursor);
        setDeliveries((current) =>
          cursor ? [...current, ...response.deliveries] : response.deliveries
        );
        setNextCursor(response.nextCursor);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : 'Failed to load deliveries');
      } finally {
        if (cursor) setDeliveriesLoadingMore(false);
        else setDeliveriesLoading(false);
      }
    },
    [projectId, toast, trigger.id]
  );

  useEffect(() => {
    void loadDeliveries();
  }, [loadDeliveries]);

  const rotate = async () => {
    const returnFocusTarget =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!window.confirm('Rotate this token now? The current token will stop working immediately.'))
      return;
    setRotating(true);
    try {
      const response = await rotateWebhookTriggerToken(projectId, trigger.id);
      setCredential({ value: response.webhookCredential, returnFocusTarget });
      onRotated();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to rotate token');
    } finally {
      setRotating(false);
    }
  };

  const runPreview = async () => {
    let payload: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(sample);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
      payload = parsed as Record<string, unknown>;
    } catch {
      toast.error('Sample payload must be a JSON object');
      return;
    }
    setPreviewing(true);
    try {
      setPreview(await previewWebhookTrigger(projectId, trigger.id, { payload }));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Preview failed');
    } finally {
      setPreviewing(false);
    }
  };

  return (
    <div className="space-y-8 mt-8">
      <section>
        <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
          <div>
            <h2 className="sam-type-section-heading m-0">Webhook credential</h2>
            <p className="text-xs text-fg-muted mt-1 mb-0">
              Active token ends in ••••{trigger.webhookConfig?.tokenLastFour ?? '—'}.
            </p>
          </div>
          <Button variant="secondary" onClick={() => void rotate()} disabled={rotating}>
            <span className="inline-flex items-center gap-2">
              {rotating ? <Spinner size="sm" /> : <RotateCw size={14} />} Rotate token
            </span>
          </Button>
        </div>
        <div className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-sm text-fg-primary">
          <KeyRound size={16} className="text-warning shrink-0 mt-0.5" />
          The full bearer token is never retrievable. Rotation invalidates the current token
          immediately.
        </div>
      </section>

      <section>
        <h2 className="sam-type-section-heading mb-3">Preview payload</h2>
        <textarea
          value={sample}
          onChange={(event) => setSample(event.target.value)}
          rows={6}
          aria-label="Sample webhook JSON"
          className="w-full rounded-md px-3 py-2 font-mono text-xs text-fg-primary resize-y"
        />
        <div className="flex justify-end mt-2">
          <Button variant="secondary" onClick={() => void runPreview()} disabled={previewing}>
            <span className="inline-flex items-center gap-2">
              {previewing ? <Spinner size="sm" /> : <Send size={14} />} Preview
            </span>
          </Button>
        </div>
        {preview && (
          <div className="mt-3 rounded-md border border-border-default p-3 min-w-0">
            <p className="text-xs text-fg-muted m-0 mb-1">
              Filters: {preview.filterResult?.matched ? 'matched' : 'did not match'}
            </p>
            <pre className="m-0 whitespace-pre-wrap break-words text-xs text-fg-primary overflow-x-auto">
              {preview.renderedPrompt}
            </pre>
          </div>
        )}
      </section>

      <section>
        <div className="flex items-center justify-between gap-3 mb-3">
          <h2 className="sam-type-section-heading m-0">Delivery history</h2>
          <button
            type="button"
            onClick={() => void loadDeliveries()}
            className="text-xs text-accent bg-transparent border-none cursor-pointer"
          >
            Refresh
          </button>
        </div>
        {deliveriesLoading ? (
          <div className="flex justify-center py-6">
            <Spinner size="sm" />
          </div>
        ) : deliveries.length === 0 ? (
          <p className="text-sm text-fg-muted border border-dashed border-border-default rounded-md p-4">
            No webhook deliveries yet.
          </p>
        ) : (
          <div className="divide-y divide-border-default border border-border-default rounded-md overflow-hidden">
            {deliveries.map((delivery) => (
              <div
                key={delivery.id}
                className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 px-3 py-2 text-sm"
              >
                <div className="min-w-0">
                  <p className="m-0 font-medium text-fg-primary capitalize">
                    {delivery.outcome.replace(/_/g, ' ')}
                  </p>
                  <p className="m-0 mt-0.5 text-xs text-fg-muted truncate">
                    {new Date(delivery.receivedAt).toLocaleString()} · {delivery.bodyBytes} bytes
                  </p>
                  {delivery.executionId && (
                    <p className="m-0 mt-1 text-xs text-fg-muted break-all">
                      Execution <code title={delivery.executionId}>{delivery.executionId}</code>
                    </p>
                  )}
                  {delivery.errorCode && (
                    <p className="m-0 mt-1 text-xs text-danger break-all">
                      Error <code>{delivery.errorCode}</code>
                    </p>
                  )}
                </div>
                <span className="text-xs text-fg-muted self-center">
                  {delivery.outcome === 'processing'
                    ? 'In progress'
                    : `HTTP ${delivery.httpStatus}`}
                </span>
              </div>
            ))}
          </div>
        )}
        {nextCursor && !deliveriesLoading && (
          <div className="flex justify-center mt-3">
            <Button
              variant="secondary"
              onClick={() => void loadDeliveries(nextCursor)}
              disabled={deliveriesLoadingMore}
            >
              {deliveriesLoadingMore ? <Spinner size="sm" /> : 'Load more'}
            </Button>
          </div>
        )}
      </section>

      {credential && (
        <WebhookCredentialDialog
          credential={credential.value}
          returnFocusTarget={credential.returnFocusTarget}
          onClose={() => setCredential(null)}
        />
      )}
    </div>
  );
}
