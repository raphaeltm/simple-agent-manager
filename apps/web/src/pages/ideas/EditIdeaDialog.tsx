/**
 * Editing the plan.
 *
 * The idea's text is meant to be the current plan, which only works if a person can change it
 * when the plan changes. It goes through the existing task PATCH route rather than a second
 * endpoint of its own (rule 24) — an idea is a task row, and that route already owns its
 * title and description.
 */
import { DEFAULT_IDEA_TITLE_MAX_LENGTH } from '@simple-agent-manager/shared';
import { Button, Dialog, Input, Textarea } from '@simple-agent-manager/ui';
import { useMutation } from '@tanstack/react-query';
import { useCallback, useEffect, useId, useState } from 'react';

import { useToast } from '../../hooks/useToast';
import type { IdeaDetail } from '../../lib/api';
import { updateProjectTask } from '../../lib/api';

export function EditIdeaDialog({
  projectId,
  idea,
  open,
  onClose,
  onSaved,
}: {
  projectId: string;
  idea: IdeaDetail;
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const titleId = useId();
  const planId = useId();
  const [title, setTitle] = useState(idea.title);
  const [plan, setPlan] = useState(idea.content ?? '');

  // Start from what is on screen each time the dialog opens, not from whatever was typed and
  // abandoned last time.
  useEffect(() => {
    if (open) {
      setTitle(idea.title);
      setPlan(idea.content ?? '');
    }
  }, [open, idea.title, idea.content]);

  const close = useCallback(() => onClose(), [onClose]);

  const save = useMutation({
    mutationFn: () =>
      // The route clears the plan when this is empty (`crud.ts`: `description?.trim() || null`).
      updateProjectTask(projectId, idea.ideaId, {
        title: title.trim(),
        description: plan.trim(),
      }),
    onSuccess: () => {
      toast.success('Plan saved');
      onSaved();
      close();
    },
    onError: (error: unknown) => {
      toast.error(error instanceof Error ? error.message : 'Could not save the plan');
    },
  });

  const canSubmit = title.trim().length > 0 && !save.isPending;

  return (
    <Dialog isOpen={open} onClose={close} maxWidth="lg" aria-labelledby={titleId}>
      <form
        className="flex min-w-0 flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (canSubmit) save.mutate();
        }}
      >
        <div className="flex min-w-0 flex-col gap-1">
          <h2 id={titleId} className="m-0 text-[19px] font-semibold text-fg-primary">
            Edit the idea
          </h2>
          <p className="m-0 text-[13px] text-fg-muted">
            This text is the current plan. Notes about what happened belong in Updates.
          </p>
        </div>

        <label className="flex min-w-0 flex-col gap-1.5">
          <span className="text-[13px] font-medium text-fg-primary">What do you want done?</span>
          <Input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            required
            maxLength={DEFAULT_IDEA_TITLE_MAX_LENGTH}
          />
        </label>

        <label className="flex min-w-0 flex-col gap-1.5" htmlFor={planId}>
          <span className="text-[13px] font-medium text-fg-primary">
            The plan <span className="font-normal text-fg-muted">— markdown</span>
          </span>
          <Textarea
            id={planId}
            value={plan}
            onChange={(event) => setPlan(event.target.value)}
            rows={10}
          />
        </label>

        <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
          <Button type="button" variant="ghost" onClick={close} disabled={save.isPending}>
            Cancel
          </Button>
          <Button type="submit" disabled={!canSubmit} loading={save.isPending}>
            Save the plan
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
