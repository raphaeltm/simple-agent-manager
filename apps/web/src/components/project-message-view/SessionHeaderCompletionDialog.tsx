import { Button, Dialog } from '@simple-agent-manager/ui';

const COPY = {
  completed: {
    title: 'Mark task as complete?',
    body: 'SAM will preserve this session so you can continue it later. Use archive or delete only when you want to remove the saved workspace state.',
    confirm: 'Mark Complete',
    variant: 'primary',
  },
  cancelled: {
    title: 'Cancel this task?',
    body: 'This task has not started. Cancelling it stops it from starting later, including after a provider limit resets.',
    confirm: 'Cancel task',
    variant: 'danger',
  },
} as const;

export function SessionHeaderCompletionDialog({
  isOpen,
  intent = 'completed',
  onClose,
  onConfirm,
}: {
  isOpen: boolean;
  intent?: 'completed' | 'cancelled';
  onClose: () => void;
  onConfirm: () => void;
}) {
  const copy = COPY[intent];
  return (
    <Dialog
      isOpen={isOpen}
      onClose={onClose}
      maxWidth="sm"
      aria-labelledby="complete-task-title"
      aria-describedby="complete-task-description"
    >
      <h3 id="complete-task-title" className="text-base font-semibold text-fg-primary mb-2">
        {copy.title}
      </h3>
      <p id="complete-task-description" className="text-sm text-fg-muted mb-4">
        {copy.body}
      </p>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onClose}>
          {intent === 'cancelled' ? 'Keep task' : 'Cancel'}
        </Button>
        <Button variant={copy.variant} size="sm" onClick={onConfirm}>
          {copy.confirm}
        </Button>
      </div>
    </Dialog>
  );
}
