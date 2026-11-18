/**
 * Filing a new idea: a title, and the plan if you already have one.
 *
 * Deliberately two fields. An idea is "something I want done" — it earns its detail later,
 * from the chats and agents that work on it, so asking for more up front would be asking for
 * work the rest of the system does on its own.
 */
import { DEFAULT_IDEA_TITLE_MAX_LENGTH } from '@simple-agent-manager/shared';
import { Button, Dialog, Input, Textarea } from '@simple-agent-manager/ui';
import { useMutation } from '@tanstack/react-query';
import { useCallback, useEffect, useId, useRef, useState } from 'react';

import { useToast } from '../../hooks/useToast';
import { createProjectIdea } from '../../lib/api';

export function NewIdeaDialog({
  projectId,
  open,
  onClose,
  onCreated,
}: {
  projectId: string;
  open: boolean;
  onClose: () => void;
  onCreated: (ideaId: string) => void;
}) {
  const toast = useToast();
  const titleId = useId();
  const planId = useId();
  const titleRef = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState('');
  const [plan, setPlan] = useState('');

  // Focused on open rather than with `autoFocus`, which fires on mount whether or not the
  // dialog is the thing the person just asked for.
  useEffect(() => {
    if (open) titleRef.current?.focus();
  }, [open]);

  const close = useCallback(() => {
    setTitle('');
    setPlan('');
    onClose();
  }, [onClose]);

  const create = useMutation({
    mutationFn: () =>
      createProjectIdea(projectId, {
        title: title.trim(),
        content: plan.trim() || undefined,
      }),
    onSuccess: (idea) => {
      toast.success('Idea filed');
      const createdId = idea.ideaId;
      close();
      onCreated(createdId);
    },
    onError: (error: unknown) => {
      toast.error(error instanceof Error ? error.message : 'Could not file the idea');
    },
  });

  const canSubmit = title.trim().length > 0 && !create.isPending;

  return (
    <Dialog isOpen={open} onClose={close} maxWidth="lg" aria-labelledby={titleId}>
      <form
        className="flex min-w-0 flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (canSubmit) create.mutate();
        }}
      >
        <div className="flex min-w-0 flex-col gap-1">
          <h2 id={titleId} className="m-0 text-[19px] font-semibold text-fg-primary">
            New idea
          </h2>
          <p className="m-0 text-[13px] text-fg-muted">
            It stays here until someone starts work on it.
          </p>
        </div>

        <label className="flex min-w-0 flex-col gap-1.5">
          <span className="text-[13px] font-medium text-fg-primary">What do you want done?</span>
          <Input
            ref={titleRef}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="Retry failed webhook deliveries"
            required
            maxLength={DEFAULT_IDEA_TITLE_MAX_LENGTH}
          />
        </label>

        <label className="flex min-w-0 flex-col gap-1.5" htmlFor={planId}>
          <span className="text-[13px] font-medium text-fg-primary">
            The plan <span className="font-normal text-fg-muted">— optional, markdown</span>
          </span>
          <Textarea
            id={planId}
            value={plan}
            onChange={(event) => setPlan(event.target.value)}
            rows={6}
            placeholder="What we want, what is out of scope, anything already decided."
          />
        </label>

        <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
          <Button type="button" variant="ghost" onClick={close} disabled={create.isPending}>
            Cancel
          </Button>
          <Button type="submit" disabled={!canSubmit} loading={create.isPending}>
            File it
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
