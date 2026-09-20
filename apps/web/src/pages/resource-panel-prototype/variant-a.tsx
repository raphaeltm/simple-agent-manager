/**
 * Variant A — "Sibling drawer".
 *
 * The consistency baseline: Resources behaves mechanically like Comments and
 * Timeline. Same glass surface, same full-screen mobile / right-rail desktop
 * geometry, same header and `p-1.5` close button, same scrolling body. Content
 * is the REAL `ResourceHistoryContent`, unchanged — the only thing this variant
 * changes is the container.
 */
import { useRef } from 'react';

import { ResourceHistoryContent } from '../../components/chat/SessionResourceHistoryDrawer';
import { useDialogFocusTrap } from '../../components/chat/useDialogFocusTrap';
import type { PrototypeDatasetId } from './mock-data';
import { ResourcePanelShell } from './panel-shell';
import { useResourceDataset } from './use-resource-dataset';
import { VariantPage } from './variant-page';

export function SiblingDrawerPanel({
  dataset,
  onClose,
  testId = 'variant-a-panel',
}: Readonly<{ dataset: PrototypeDatasetId; onClose: () => void; testId?: string }>) {
  const panelRef = useRef<HTMLDialogElement>(null);
  useDialogFocusTrap(panelRef, onClose);
  const view = useResourceDataset(dataset);

  return (
    <ResourcePanelShell panelRef={panelRef} onClose={onClose} testId={testId}>
      <ResourceHistoryContent
        isLoading={view.isLoading}
        isError={view.isError}
        isFetching={view.isFetching}
        history={view.history}
        summary={view.summary}
        effectiveChunkId={view.effectiveChunkId}
        detail={view.detail}
        onSelectChunk={view.selectChunk}
      />
    </ResourcePanelShell>
  );
}

export function ResourcePanelVariantA() {
  return (
    <VariantPage
      variantLabel="A · Sibling drawer"
      renderPanel={({ dataset, onClose }) => (
        <SiblingDrawerPanel dataset={dataset} onClose={onClose} />
      )}
    />
  );
}
