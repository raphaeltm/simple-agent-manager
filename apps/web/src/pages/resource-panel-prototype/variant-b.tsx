/**
 * Variant B — "Bottom sheet".
 *
 * Mobile-native: Resources rises over the conversation instead of replacing it.
 * PEEK (~52dvh) shows the stat cards and the OOM banner — enough to answer "did
 * something blow up?" without leaving the chat. Drag up for FULL, down to
 * dismiss. On >=md it falls back to variant A's right rail, because a bottom
 * sheet on a 1280px screen is a worse drawer than a drawer.
 */
import { useRef } from 'react';

import { ResourceHistoryContent } from '../../components/chat/SessionResourceHistoryDrawer';
import { useDialogFocusTrap } from '../../components/chat/useDialogFocusTrap';
import { useIsMobile } from '../../hooks/useIsMobile';
import type { PrototypeDatasetId } from './mock-data';
import { ResourcePanelHeader } from './panel-shell';
import { useResourceDataset } from './use-resource-dataset';
import { FULL_TOP_GAP_PX, SNAP_TRANSITION_MS, useSheetDrag } from './use-sheet-drag';
import { SiblingDrawerPanel } from './variant-a';
import { VariantPage } from './variant-page';

/**
 * The grab handle is a real button, not a decorative div: dragging is the
 * primary gesture but a tap (or Enter) has to work too, and a click handler on a
 * plain div is unreachable by keyboard.
 */
function GrabHandle({ expanded, onToggle }: Readonly<{ expanded: boolean; onToggle: () => void }>) {
  return (
    <button
      type="button"
      data-testid="variant-b-grab-handle"
      aria-label={expanded ? 'Collapse the resources sheet' : 'Expand the resources sheet'}
      aria-expanded={expanded}
      onClick={onToggle}
      className="flex h-11 w-full shrink-0 cursor-grab items-center justify-center border-none bg-transparent active:cursor-grabbing"
    >
      {/* Tokenized inline: neither the `bg-border-strong` utility nor the
          `--sam-color-border-strong` variable exists in this app, so both of the
          obvious spellings render invisible. */}
      <span
        aria-hidden="true"
        className="h-[5px] w-9 rounded-full opacity-60"
        style={{ backgroundColor: 'var(--sam-color-fg-muted)' }}
      />
    </button>
  );
}

function BottomSheetPanel({
  dataset,
  onClose,
}: Readonly<{ dataset: PrototypeDatasetId; onClose: () => void }>) {
  const sheetRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  useDialogFocusTrap(sheetRef, onClose);
  const view = useResourceDataset(dataset);
  const sheet = useSheetDrag(onClose);
  const atFull = sheet.snap === 'full';

  return (
    <>
      {/*
        Half the usual dim: the point of a sheet over a fullscreen drawer is that
        the conversation stays legible behind it.
      */}
      <div
        className="glass-backdrop-dim fixed inset-0 z-40"
        style={{ opacity: 0.5 }}
        onClick={onClose}
        aria-hidden="true"
      />

      <div
        ref={(el) => {
          sheetRef.current = el;
          sheet.setSheetEl(el);
        }}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="Session resources"
        data-testid="variant-b-sheet"
        data-snap={sheet.snap}
        className="glass-panel-container glass-composited glass-modal fixed inset-x-0 bottom-0 z-50 flex flex-col overflow-hidden rounded-t-[20px] border-x-0 border-b-0 shadow-xl"
        style={{
          height: `calc(100dvh - ${FULL_TOP_GAP_PX}px - env(safe-area-inset-top))`,
          transform: `translateY(${sheet.translate}px)`,
          transition: sheet.dragging ? 'none' : `transform ${SNAP_TRANSITION_MS}ms ease-out`,
          willChange: 'transform',
          opacity: sheet.ready ? 1 : 0,
        }}
      >
        {/* `touch-action: none` only here — the body needs native panning at FULL. */}
        <div
          data-testid="variant-b-drag-zone"
          style={{ touchAction: 'none' }}
          onPointerDown={sheet.onPointerDown}
        >
          <GrabHandle
            expanded={atFull}
            onToggle={() => {
              // A pointer drag also emits a click on release; without this the
              // drag snapped to FULL and the synthesized click undid it.
              if (sheet.dragMoved.current) return;
              sheet.snapTo(atFull ? 'peek' : 'full');
            }}
          />
          <ResourcePanelHeader onClose={onClose} />
        </div>

        <div
          ref={bodyRef}
          data-testid="variant-b-body"
          className="min-h-0 flex-1 space-y-3 p-3"
          style={{
            // Scrollable ONLY at FULL. At PEEK a drag on the body moves the
            // sheet instead, which is what makes PEEK feel like a handle rather
            // than a cropped panel.
            overflowY: atFull ? 'auto' : 'hidden',
            overscrollBehavior: 'contain',
            touchAction: atFull ? 'pan-y' : 'none',
          }}
          onPointerDown={(event) => {
            if (!atFull) {
              sheet.onPointerDown(event);
              return;
            }
            // At FULL, only a downward drag from the very top collapses.
            if ((bodyRef.current?.scrollTop ?? 0) <= 0) {
              sheet.onPointerDown(event, { downOnly: true });
            }
          }}
        >
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
        </div>
      </div>
    </>
  );
}

function VariantBPanel({
  dataset,
  onClose,
}: Readonly<{ dataset: PrototypeDatasetId; onClose: () => void }>) {
  const isMobile = useIsMobile();
  if (!isMobile) {
    return <SiblingDrawerPanel dataset={dataset} onClose={onClose} testId="variant-b-panel" />;
  }
  return <BottomSheetPanel dataset={dataset} onClose={onClose} />;
}

export function ResourcePanelVariantB() {
  return (
    <VariantPage
      variantLabel="B · Bottom sheet"
      renderPanel={({ dataset, onClose }) => <VariantBPanel dataset={dataset} onClose={onClose} />}
    />
  );
}
