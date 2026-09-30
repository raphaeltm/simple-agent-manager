import { AcpInteractionOptionSchema } from '@simple-agent-manager/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import * as v from 'valibot';

import {
  type AcpInteractionSnapshotItem,
  answerAcpInteraction,
  getAcpInteractionDetail,
} from '../../lib/api/acp-interactions';
import { ApiClientError } from '../../lib/api/client';

const DEADLINE_TICK_MS = 1_000;

export type PermissionOption = v.InferOutput<typeof AcpInteractionOptionSchema>;
export interface PermissionDetail {
  title: string;
  description: string | null;
  options: PermissionOption[];
}
export type Submission = {
  answerKey: string;
  option: PermissionOption;
  answerHash: string;
  status: 'submitting' | 'accepted' | 'uncertain' | 'conflict' | 'revoked';
  message: string | null;
};

interface UseAcpPermissionCardParams {
  interaction: AcpInteractionSnapshotItem;
  projectId: string;
  sessionId: string;
  canAnswer: boolean;
  onRefresh: () => Promise<unknown>;
}

function parsePermissionDetail(value: Record<string, unknown> | null): PermissionDetail | null {
  if (!value || !Array.isArray(value.options) || value.options.length === 0) return null;
  const options: PermissionOption[] = [];
  const optionIds = new Set<string>();
  for (const candidate of value.options) {
    const parsed = v.safeParse(AcpInteractionOptionSchema, candidate);
    if (!parsed.success || optionIds.has(parsed.output.id)) return null;
    optionIds.add(parsed.output.id);
    options.push(parsed.output);
  }
  const titleCandidate = value.title ?? value.permissionName;
  const title =
    typeof titleCandidate === 'string' && titleCandidate.trim()
      ? titleCandidate
      : 'Permission request';
  const description =
    typeof value.description === 'string' && value.description.trim() ? value.description : null;
  return { title, description, options };
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function usePermissionDeadline(interaction: AcpInteractionSnapshotItem, onRefresh: () => unknown) {
  const [now, setNow] = useState(() => Date.now());
  const requestedRefresh = useRef(false);
  const isPending = interaction.state === 'pending';
  const deadlinePassed = isPending && now >= interaction.deadlineAt;
  useEffect(() => {
    if (!isPending) return;
    const timer = window.setInterval(() => setNow(Date.now()), DEADLINE_TICK_MS);
    return () => window.clearInterval(timer);
  }, [isPending]);
  useEffect(() => {
    if (!deadlinePassed || requestedRefresh.current) return;
    requestedRefresh.current = true;
    void onRefresh();
  }, [deadlinePassed, onRefresh]);
  return { now, setNow, isPending, deadlinePassed };
}

function usePermissionDetail(params: {
  projectId: string;
  sessionId: string;
  interactionId: string;
  mayReveal: boolean;
}) {
  const { projectId, sessionId, interactionId, mayReveal } = params;
  const [detail, setDetail] = useState<PermissionDetail | null>(null);
  const [state, setState] = useState<'idle' | 'loading' | 'ready' | 'error' | 'revoked'>('idle');
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    if (!mayReveal) {
      setDetail(null);
      setState('idle');
      return;
    }
    const controller = new AbortController();
    let active = true;
    setDetail(null);
    setState('loading');
    void loadPermissionDetail(projectId, sessionId, interactionId, controller.signal).then(
      (result) => {
        if (!active) return;
        setDetail(result.detail);
        setState(result.state);
      }
    );
    return () => {
      active = false;
      controller.abort();
    };
  }, [interactionId, mayReveal, nonce, projectId, sessionId]);
  const revoke = useCallback(() => {
    setDetail(null);
    setState('revoked');
  }, []);
  return { detail, state, retry: () => setNonce((value) => value + 1), revoke };
}

async function loadPermissionDetail(
  projectId: string,
  sessionId: string,
  interactionId: string,
  signal: AbortSignal
): Promise<{ detail: PermissionDetail | null; state: 'ready' | 'error' | 'revoked' }> {
  try {
    const response = await getAcpInteractionDetail(projectId, sessionId, interactionId, signal);
    const detail = parsePermissionDetail(response.detail);
    return { detail, state: detail ? 'ready' : 'error' };
  } catch (error: unknown) {
    const revoked =
      error instanceof ApiClientError && (error.status === 401 || error.status === 403);
    return { detail: null, state: revoked ? 'revoked' : 'error' };
  }
}

function submissionFailure(error: unknown, next: Submission): Submission {
  if (error instanceof ApiClientError && (error.status === 401 || error.status === 403)) {
    return {
      ...next,
      status: 'revoked',
      message: 'Your access changed before the answer was accepted.',
    };
  }
  if (error instanceof ApiClientError && error.status === 409) {
    return {
      ...next,
      status: 'conflict',
      message: 'Another tab or user already answered this request. Refreshing…',
    };
  }
  return {
    ...next,
    status: 'uncertain',
    message: 'The receipt was lost. Retry to check using the same answer key.',
  };
}

function usePermissionSubmission(params: {
  projectId: string;
  sessionId: string;
  interactionId: string;
  mayReveal: boolean;
  onRefresh: () => Promise<unknown>;
  onRevoked: () => void;
}) {
  const { projectId, sessionId, interactionId, mayReveal, onRefresh, onRevoked } = params;
  const [submission, setSubmission] = useState<Submission | null>(null);
  useEffect(() => {
    if (!mayReveal) setSubmission(null);
  }, [mayReveal]);
  const submit = useCallback(
    async (next: Submission) => {
      setSubmission({ ...next, status: 'submitting', message: null });
      try {
        await answerAcpInteraction(projectId, sessionId, interactionId, {
          answerKey: next.answerKey,
          decision: {
            kind: 'selected_option',
            optionId: next.option.id,
            answerHash: next.answerHash,
          },
        });
        setSubmission({
          ...next,
          status: 'accepted',
          message: 'Answer saved. Checking delivery status…',
        });
        await onRefresh();
      } catch (error: unknown) {
        const failed = submissionFailure(error, next);
        if (failed.status === 'revoked') onRevoked();
        setSubmission(failed);
        if (failed.status === 'conflict') await onRefresh();
      }
    },
    [interactionId, onRefresh, onRevoked, projectId, sessionId]
  );
  return { submission, submit };
}

export function useAcpPermissionCard(params: UseAcpPermissionCardParams) {
  const { interaction, projectId, sessionId, canAnswer, onRefresh } = params;
  const deadline = usePermissionDeadline(interaction, onRefresh);
  const mayReveal = canAnswer && deadline.isPending && !deadline.deadlinePassed;
  const detail = usePermissionDetail({
    projectId,
    sessionId,
    interactionId: interaction.interactionId,
    mayReveal,
  });
  const submission = usePermissionSubmission({
    projectId,
    sessionId,
    interactionId: interaction.interactionId,
    mayReveal,
    onRefresh,
    onRevoked: detail.revoke,
  });
  const { submission: currentSubmission, submit } = submission;
  const { deadlinePassed, setNow } = deadline;
  const chooseOption = useCallback(
    async (option: PermissionOption) => {
      if (currentSubmission || deadlinePassed) return;
      const answerHash = await sha256Hex(option.id);
      if (Date.now() >= interaction.deadlineAt) {
        setNow(Date.now());
        return;
      }
      await submit({
        option,
        answerKey: crypto.randomUUID(),
        answerHash,
        status: 'submitting',
        message: null,
      });
    },
    [currentSubmission, deadlinePassed, interaction.deadlineAt, setNow, submit]
  );
  return {
    ...deadline,
    mayReveal,
    secureDetail: mayReveal ? detail.detail : null,
    detailState: detail.state,
    retryDetail: detail.retry,
    ...submission,
    chooseOption,
  };
}
