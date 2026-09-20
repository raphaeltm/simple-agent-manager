/**
 * Boilerplate every variant shares: the scroll frame, the dataset toolbar, the
 * chat stand-in, and open/close state for the panel. Variants supply only the
 * panel itself.
 */
import { type ReactNode, useState } from 'react';

import { ChatBackdrop } from './chat-backdrop';
import type { PrototypeDatasetId } from './mock-data';
import { PrototypeFrame, PrototypeToolbar } from './prototype-chrome';

export function VariantPage({
  variantLabel,
  renderPanel,
}: Readonly<{
  variantLabel: string;
  renderPanel: (args: { dataset: PrototypeDatasetId; onClose: () => void }) => ReactNode;
}>) {
  const [dataset, setDataset] = useState<PrototypeDatasetId>('rich');
  const [open, setOpen] = useState(false);

  return (
    <PrototypeFrame>
      <div className="flex h-[100dvh] flex-col">
        <PrototypeToolbar
          variantLabel={variantLabel}
          dataset={dataset}
          onDatasetChange={setDataset}
        />
        <ChatBackdrop onOpenResources={() => setOpen(true)} />
      </div>
      {open && renderPanel({ dataset, onClose: () => setOpen(false) })}
    </PrototypeFrame>
  );
}
