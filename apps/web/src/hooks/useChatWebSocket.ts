import { BASE_RECONNECT_DELAY, MAX_RECONNECT_DELAY, MAX_RETRIES } from './chat-websocket-config';
import type {
  ChatConnectionState,
  SessionUpdatedFields,
  UseChatWebSocketOptions,
  UseChatWebSocketReturn,
} from './chat-websocket-types';
import { useChatSocketKeepAlive } from './useChatSocketKeepAlive';
export type {
  ChatConnectionState,
  SessionUpdatedFields,
  UseChatWebSocketReturn,
  WakeProgressUpdate,
} from './chat-websocket-types';
import {
  CHAT_MESSAGE_APPEND_CAPABILITY,
  CHAT_TOOL_REPLACE_CAPABILITY,
  type ChatMessageAppend,
  DEFAULT_CHAT_SESSION_MESSAGE_LIMIT,
  isTaskExecutionStep,
} from '@simple-agent-manager/shared';
import { useCallback, useEffect, useRef, useState } from 'react';

import type { ChatMessageResponse } from '../lib/api';
import { getChatSession } from '../lib/api';
import {
  mapBackendMessageCommentThread,
  type MessageCommentRealtimeEvent,
} from '../lib/api/comments';
import { mergeMessages } from '../lib/merge-messages';
import { fetchHistoryUntil } from '../lib/message-paging';
import { parsePromptDeliveryUpdate } from '../lib/prompt-delivery-update';
import { maybeJsonRecord } from '../lib/runtime-validation';

/**
 * The statuses the DO pushes in `session.updated` (`applySessionSleep`, `wakeSession`).
 * Stopped and failed arrive as their own events, which also clear the agent's activity.
 */
const PUSHED_SESSION_STATUSES: readonly string[] = ['active', 'sleeping'];

export function useChatWebSocket({
  projectId,
  sessionId,
  enabled,
  onMessage,
  onMessageAppend,
  onSessionStopped,
  onSubscribed,
  onCatchUp,
  onAgentCompleted,
  onAgentActivity,
  onDeliveryUpdate,
  onSessionUpdated,
  onWakeProgress,
  onCommentEvent,
  onSessionAccessChanged,
}: UseChatWebSocketOptions): UseChatWebSocketReturn {
  const [connectionState, setConnectionState] = useState<ChatConnectionState>('disconnected');

  const wsRef = useRef<WebSocket | null>(null);
  const retriesRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const pongTimeoutRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const mountedRef = useRef(true);
  const connectRef = useRef<() => void>(() => {});
  const hadConnectionRef = useRef(false);
  const pendingAppendsRef = useRef<ChatMessageAppend[]>([]);
  const appendRecoveryPageRef = useRef<ChatMessageResponse[] | null>(null);
  const catchUpFlightRef = useRef<Promise<void> | null>(null);

  // Keep callbacks stable via refs
  const onMessageRef = useRef(onMessage);
  const onMessageAppendRef = useRef(onMessageAppend);
  const onSessionStoppedRef = useRef(onSessionStopped);
  const onSubscribedRef = useRef(onSubscribed);
  const onCatchUpRef = useRef(onCatchUp);
  const onAgentCompletedRef = useRef(onAgentCompleted);
  const onAgentActivityRef = useRef(onAgentActivity);
  const onDeliveryUpdateRef = useRef(onDeliveryUpdate);
  const onSessionUpdatedRef = useRef(onSessionUpdated);
  const onWakeProgressRef = useRef(onWakeProgress);
  const onCommentEventRef = useRef(onCommentEvent);
  const onSessionAccessChangedRef = useRef(onSessionAccessChanged);
  onMessageRef.current = onMessage;
  onMessageAppendRef.current = onMessageAppend;
  onSessionStoppedRef.current = onSessionStopped;
  onSubscribedRef.current = onSubscribed;
  onCatchUpRef.current = onCatchUp;
  onAgentCompletedRef.current = onAgentCompleted;
  onAgentActivityRef.current = onAgentActivity;
  onDeliveryUpdateRef.current = onDeliveryUpdate;
  onSessionUpdatedRef.current = onSessionUpdated;
  onWakeProgressRef.current = onWakeProgress;
  onCommentEventRef.current = onCommentEvent;
  onSessionAccessChangedRef.current = onSessionAccessChanged;

  const getReconnectDelay = useCallback((attempt: number) => {
    return Math.min(BASE_RECONNECT_DELAY * Math.pow(2, attempt), MAX_RECONNECT_DELAY);
  }, []);

  const scheduleReconnect = useCallback(() => {
    if (!mountedRef.current) return;
    if (retriesRef.current >= MAX_RETRIES) {
      setConnectionState('disconnected');
      return;
    }

    setConnectionState('reconnecting');
    const delay = getReconnectDelay(retriesRef.current);
    retriesRef.current++;

    reconnectTimerRef.current = setTimeout(() => {
      if (mountedRef.current) {
        connectRef.current();
      }
    }, delay);
  }, [getReconnectDelay]);

  const connect = useCallback(() => {
    if (!mountedRef.current) return;
    catchUpFlightRef.current = null;

    setConnectionState(retriesRef.current === 0 ? 'connecting' : 'reconnecting');

    // Clean up existing socket
    if (wsRef.current) {
      wsRef.current.close(1000);
      wsRef.current = null;
    }

    const API_URL = import.meta.env.VITE_API_URL || '';
    const wsUrl =
      API_URL.replace(/^http/, 'ws') +
      `/api/projects/${projectId}/sessions/ws?sessionId=${encodeURIComponent(sessionId)}&toolReplace=${CHAT_TOOL_REPLACE_CAPABILITY}` +
      (onMessageAppendRef.current ? `&messageAppend=${CHAT_MESSAGE_APPEND_CAPABILITY}` : '');

    try {
      const ws = new WebSocket(wsUrl);

      ws.onopen = () => {
        if (!mountedRef.current || wsRef.current !== ws) {
          ws.close(1000);
          return;
        }
        const wasReconnect = hadConnectionRef.current;
        retriesRef.current = 0;
        setConnectionState('connected');
        hadConnectionRef.current = true;

        // A reconnect re-reads the newest window. Any other open follows a REST read that this
        // socket did not see the end of: a page load, or a wake after the socket was off. A row
        // persisted between that read and now, such as a comment sent to the agent, reached no
        // socket, so the consumer reads forward from its newest row. It runs here, before any
        // frame of this socket, so a newer live row cannot move its cursor past the missed one.
        // Consumers merge what they read: a replace racing the initial load once made messages
        // appear and then disappear.
        if (wasReconnect) {
          void catchUpMessages();
        } else {
          onSubscribedRef.current?.();
        }
      };

      ws.onmessage = (event) => {
        if (!mountedRef.current || wsRef.current !== ws || ws.readyState !== WebSocket.OPEN) return;

        try {
          const data = JSON.parse(event.data);
          const payload = data.payload ?? data;

          // Handle pong response — clear the pong timeout to indicate the
          // connection is alive. Without this, the timeout would fire and
          // force-close the socket even though the server is responsive.
          if (data.type === 'pong') {
            clearTimeout(pongTimeoutRef.current);
            return;
          }

          if (data.type === 'message.append') {
            if (payload.sessionId !== sessionId) return;
            if (
              typeof payload.id !== 'string' ||
              typeof payload.content !== 'string' ||
              !Number.isSafeInteger(payload.offset) ||
              !Number.isSafeInteger(payload.revision) ||
              payload.offset < 0 ||
              payload.revision !== payload.offset + payload.content.length
            )
              return;
            const append: ChatMessageAppend = {
              id: payload.id,
              sessionId,
              content: payload.content,
              offset: payload.offset,
              revision: payload.revision,
            };
            if (!onMessageAppendRef.current?.(append)) {
              pendingAppendsRef.current.push(append);
              if (pendingAppendsRef.current.length > DEFAULT_CHAT_SESSION_MESSAGE_LIMIT) {
                // Preserve recovery targets across reconnect; ignore further
                // frames once close begins so this queue remains bounded.
                ws.close(4000);
                return;
              }
              void catchUpMessages();
            }
          } else if (data.type === 'message.new') {
            const p = payload;
            if (p.sessionId !== sessionId) return;
            // Only deliver if content is present (broadcast now includes it)
            if (!p.content) return;
            const newMsg: ChatMessageResponse = {
              id: p.messageId || p.id || crypto.randomUUID(),
              sessionId: p.sessionId,
              role: p.role,
              content: p.content,
              toolMetadata: p.toolMetadata || null,
              createdAt: p.createdAt || Date.now(),
              sequence: p.sequence ?? null,
            };
            onMessageRef.current(newMsg);
          } else if (data.type === 'messages.batch') {
            const p = payload;
            if (p.sessionId !== sessionId) return;
            const msgs: ChatMessageResponse[] = (p.messages ?? [])
              .filter((m: Record<string, unknown>) => m.content)
              .map((m: Record<string, unknown>) => ({
                id: (m.id as string) || crypto.randomUUID(),
                sessionId: sessionId,
                role: (m.role as string) || 'assistant',
                content: m.content as string,
                toolMetadata: maybeJsonRecord(m.toolMetadata),
                createdAt: (m.createdAt as number) || Date.now(),
                sequence: (m.sequence as number) ?? null,
              }));
            for (const msg of msgs) {
              onMessageRef.current(msg);
            }
          } else if (data.type === 'session.stopped' || data.type === 'session.failed') {
            const p = payload;
            if (p.sessionId !== sessionId) return;
            onSessionStoppedRef.current();
          } else if (data.type === 'session.agent_completed') {
            const p = payload;
            if (p.sessionId !== sessionId) return;
            onAgentCompletedRef.current?.(p.agentCompletedAt ?? Date.now());
          } else if (data.type === 'session.updated') {
            const p = payload;
            if (p.sessionId !== sessionId) return;
            const updates: SessionUpdatedFields = {};
            // The DO pushes the sleep/wake transition here (`applySessionSleep`,
            // `wakeSession`). A connected active tab does not poll, so dropping it
            // left an open tab showing an active composer after the server slept the
            // session, and the next message went out as a prompt, not a wake.
            if (typeof p.status === 'string' && PUSHED_SESSION_STATUSES.includes(p.status)) {
              updates.status = p.status;
            }
            if (typeof p.topic === 'string' || p.topic === null) {
              updates.topic = p.topic;
            }
            if (typeof p.workspaceId === 'string' || p.workspaceId === null) {
              updates.workspaceId = p.workspaceId;
            }
            // Pushed when the DO registers the ACP session (createAcpSession), so a
            // page opened before the agent started still learns its session id.
            if (typeof p.agentSessionId === 'string') {
              updates.agentSessionId = p.agentSessionId;
            }
            if (Object.keys(updates).length > 0) {
              onSessionUpdatedRef.current?.(updates);
            }
          } else if (data.type === 'session.activity') {
            const p = payload;
            if (p.sessionId !== sessionId) return;
            if (
              p.activity === 'prompting' ||
              p.activity === 'idle' ||
              p.activity === 'recovering' ||
              p.activity === 'error'
            ) {
              onAgentActivityRef.current?.(
                p.activity,
                p.promptStartedAt ?? null,
                typeof p.steeringSupported === 'boolean' ? p.steeringSupported : undefined
              );
            }
          } else if (data.type === 'mailbox.delivery_updated') {
            const update = parsePromptDeliveryUpdate(payload);
            if (update) onDeliveryUpdateRef.current?.(update);
          } else if (data.type === 'session.wake_progress') {
            const p = payload;
            if (p.sessionId !== sessionId) return;
            if (
              p.recoveryStatus === 'waking' ||
              p.recoveryStatus === 'restored' ||
              p.recoveryStatus === 'failed'
            ) {
              onWakeProgressRef.current?.({
                recoveryStatus: p.recoveryStatus,
                // An unknown/absent step is normal early in a wake — the runner has
                // been claimed but has not written its first execution step yet.
                wakePhase: isTaskExecutionStep(p.wakePhase) ? p.wakePhase : null,
                wakeAttemptId: typeof p.wakeAttemptId === 'string' ? p.wakeAttemptId : null,
              });
            }
          } else if (data.type === 'session.access.changed') {
            const p = payload;
            if (p.sessionId !== sessionId) return;
            onSessionAccessChangedRef.current?.();
          } else if (data.type === 'comment.thread.changed') {
            const p = payload;
            if (p.sessionId !== sessionId || !p.thread) return;
            const type =
              p.reason === 'reply_created'
                ? 'comment.reply.created'
                : p.reason === 'thread_created'
                  ? 'comment.thread.created'
                  : 'comment.thread.updated';
            onCommentEventRef.current?.({
              type,
              payload: {
                projectId,
                sessionId: p.sessionId,
                comment: mapBackendMessageCommentThread(projectId, p.thread),
              },
            } as MessageCommentRealtimeEvent);
          } else if (
            data.type === 'comment.thread.created' ||
            data.type === 'comment.thread.updated' ||
            data.type === 'comment.reply.created'
          ) {
            onCommentEventRef.current?.({
              type: data.type,
              payload,
            } as MessageCommentRealtimeEvent);
          }
        } catch {
          // Ignore malformed messages
        }
      };

      ws.onclose = (event) => {
        if (!mountedRef.current) return;
        // Guard: only handle close if this is still the active socket.
        // A newer connect() call may have already replaced wsRef.current.
        if (wsRef.current !== ws) return;
        wsRef.current = null;
        if (event.code !== 1000) {
          scheduleReconnect();
        } else {
          setConnectionState('disconnected');
        }
      };

      ws.onerror = () => {
        // Error is followed by close event
      };

      wsRef.current = ws;
    } catch {
      scheduleReconnect();
    }
  }, [projectId, sessionId, scheduleReconnect]);

  connectRef.current = connect;

  const catchUpMessages = useCallback((): Promise<void> => {
    if (catchUpFlightRef.current) return catchUpFlightRef.current;
    const socket = wsRef.current;
    const flight = (async () => {
      try {
        // Reconnect catch-up fetches only the recent window (like the poll), not the
        // whole conversation — mergeReplace preserves any earlier-loaded history.
        const data = await getChatSession(projectId, sessionId, {
          limit: DEFAULT_CHAT_SESSION_MESSAGE_LIMIT,
        });
        if (!mountedRef.current || wsRef.current !== socket) return;
        await onCatchUpRef.current(data.messages, data.session, data.state, data.toolChanges);
        if (!mountedRef.current || wsRef.current !== socket) return;
        // Keep entries queued until applied: rejected history requests and socket
        // replacement must leave every unprocessed delta available for retry.
        const pending = pendingAppendsRef.current.slice();
        const acknowledge = (append: ChatMessageAppend) => {
          const index = pendingAppendsRef.current.indexOf(append);
          if (index >= 0) pendingAppendsRef.current.splice(index, 1);
        };
        for (const append of pending) {
          if (!mountedRef.current || wsRef.current !== socket) return;
          if (onMessageAppendRef.current?.(append)) {
            acknowledge(append);
            continue;
          }
          // A base can have fallen behind the newest window while its initial
          // snapshot was loading. Read authoritative history to its exact ID,
          // independently of gaps in the cache, before retrying the delta.
          const start = appendRecoveryPageRef.current ?? data.messages;
          const older = await fetchHistoryUntil(projectId, sessionId, start, {
            messageId: append.id,
            timestamp: 0,
          });
          if (!mountedRef.current || wsRef.current !== socket) return;
          const recovered = mergeMessages(start, older.messages, 'prepend');
          await onCatchUpRef.current(recovered, data.session, data.state);
          if (!mountedRef.current || wsRef.current !== socket) return;
          if (!onMessageAppendRef.current?.(append)) {
            // Keep only the oldest page as the next pass's cursor; the cache
            // already holds the recovered rows. Progress survives reconnects.
            appendRecoveryPageRef.current = recovered.slice(0, DEFAULT_CHAT_SESSION_MESSAGE_LIMIT);
            if (!older.hasMore) {
              socket?.close(1000);
              return;
            }
          } else {
            acknowledge(append);
          }
        }
        if (pendingAppendsRef.current.length === 0) appendRecoveryPageRef.current = null;
        if (wsRef.current === socket && pendingAppendsRef.current.length > 0) socket?.close(4000);
      } catch {
        // Reconnect recovers a missing base even if this was the stream's final batch.
        if (wsRef.current === socket && pendingAppendsRef.current.length > 0) socket?.close(4000);
      }
    })();
    catchUpFlightRef.current = flight;
    void flight.finally(() => {
      if (catchUpFlightRef.current === flight) catchUpFlightRef.current = null;
    });
    return flight;
  }, [projectId, sessionId]);

  useChatSocketKeepAlive(enabled, wsRef, pongTimeoutRef);

  // Connection lifecycle
  useEffect(() => {
    pendingAppendsRef.current = [];
    appendRecoveryPageRef.current = null;
    catchUpFlightRef.current = null;
    if (!enabled) {
      // Disconnect when disabled
      if (wsRef.current) {
        wsRef.current.close(1000);
        wsRef.current = null;
      }
      clearTimeout(reconnectTimerRef.current);
      clearTimeout(pongTimeoutRef.current);
      setConnectionState('disconnected');
      hadConnectionRef.current = false;
      retriesRef.current = 0;
      return;
    }

    mountedRef.current = true;
    connectRef.current();

    return () => {
      mountedRef.current = false;
      clearTimeout(reconnectTimerRef.current);
      clearTimeout(pongTimeoutRef.current);
      if (wsRef.current) {
        wsRef.current.close(1000);
        wsRef.current = null;
      }
    };
  }, [enabled, projectId, sessionId]);

  const retry = useCallback(() => {
    retriesRef.current = 0;
    // Keep hadConnectionRef.current = true so catch-up fires on reconnect
    clearTimeout(reconnectTimerRef.current);
    connectRef.current();
  }, []);

  return {
    connectionState,
    wsRef,
    retry,
  };
}
