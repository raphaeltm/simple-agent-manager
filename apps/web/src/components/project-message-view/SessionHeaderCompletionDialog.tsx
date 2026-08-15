import { Button, Dialog } from '@simple-agent-manager/ui';

export function SessionHeaderCompletionDialog({
  isOpen,
  onClose,
  onConfirm,
}: {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog
      isOpen={isOpen}
      onClose={onClose}
      maxWidth="sm"
      aria-labelledby="complete-task-title"
      aria-describedby="complete-task-description"
    >
      <h3 id="complete-task-title" className="text-base font-semibold text-fg-primary mb-2">
        Mark task as complete?
      </h3>
      <p id="complete-task-description" className="text-sm text-fg-muted mb-4">
        SAM will preserve this session so you can continue it later. Use archive or delete only when
        you want to remove the saved workspace state.
      </p>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" size="sm" onClick={onConfirm}>
          Mark Complete
        </Button>
      </div>
    </Dialog>
  );
}
