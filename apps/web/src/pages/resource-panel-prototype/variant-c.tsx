/**
 * Variant C — "Inspector".
 *
 * Same geometry as variant A; different information architecture. The summary
 * strip and segment switcher are pinned siblings of the scroller rather than
 * `position: sticky` children of it — same visual result, and it cannot be
 * defeated by a `contain`/`overflow` ancestor.
 */
import { useRef, useState } from 'react';

import { useDialogFocusTrap } from '../../components/chat/useDialogFocusTrap';
import {
  AboutSegment,
  ChunksSegment,
  InspectorEmptyState,
  InspectorErrorState,
  type InspectorSegment,
  SegmentedControl,
  SummaryStrip,
  TimelineSegment,
} from './inspector-content';
import type { PrototypeDatasetId } from './mock-data';
import { ResourcePanelShell } from './panel-shell';
import { useResourceDataset } from './use-resource-dataset';
import { VariantPage } from './variant-page';

function InspectorPanel({
  dataset,
  onClose,
}: Readonly<{ dataset: PrototypeDatasetId; onClose: () => void }>) {
  const panelRef = useRef<HTMLDialogElement>(null);
  useDialogFocusTrap(panelRef, onClose);
  // Chart-first means the chart cannot wait for a tap, so the newest window
  // loads on open.
  const view = useResourceDataset(dataset, { autoLoadDetail: true });
  const [segment, setSegment] = useState<InspectorSegment>('timeline');

  const chunks = view.history?.chunks ?? [];
  const isEmpty = !view.isError && !view.summary && chunks.length === 0;

  const selectChunkAndShowTimeline = (chunkId: string) => {
    view.selectChunk(chunkId);
    setSegment('timeline');
  };

  return (
    <ResourcePanelShell
      panelRef={panelRef}
      onClose={onClose}
      testId="variant-c-panel"
      belowHeader={
        view.isError || isEmpty ? null : (
          <>
            <SummaryStrip summary={view.summary} />
            <SegmentedControl value={segment} onChange={setSegment} />
          </>
        )
      }
    >
      {view.isError && <InspectorErrorState />}
      {isEmpty && <InspectorEmptyState />}
      {!view.isError && !isEmpty && (
        <>
          {segment === 'timeline' && (
            <TimelineSegment
              chunks={chunks}
              selectedChunkId={view.effectiveChunkId}
              detail={view.detail}
              isFetching={view.isFetching}
              onSelectChunk={selectChunkAndShowTimeline}
            />
          )}
          {segment === 'chunks' && (
            <ChunksSegment
              chunks={chunks}
              selectedChunkId={view.effectiveChunkId}
              onSelect={selectChunkAndShowTimeline}
            />
          )}
          {segment === 'about' && <AboutSegment />}
        </>
      )}
    </ResourcePanelShell>
  );
}

export function ResourcePanelVariantC() {
  return (
    <VariantPage
      variantLabel="C · Inspector"
      renderPanel={({ dataset, onClose }) => <InspectorPanel dataset={dataset} onClose={onClose} />}
    />
  );
}
