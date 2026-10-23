/**
 * Pre-fills the new-chat composer from a link, then removes the parameters so a reload does
 * not fill it again:
 * - `?executeIdea=<id>` asks an agent to run that idea (`EXECUTE_IDEA_PROMPT_TEMPLATE`);
 * - `?deployHelp=<environment>&deployIntent=fix|deploy` is the Deployments page's "Ask an
 *   agent". Only a valid environment name reaches the template (`deployHelpPrompt`), so a
 *   link cannot put arbitrary text in the composer.
 *
 * Returns the idea ID being executed, so the chat that is sent can be linked to it.
 */
import { type MutableRefObject, useEffect, useRef } from 'react';
import { useSearchParams } from 'react-router';

import { deployHelpPrompt, EXECUTE_IDEA_PROMPT_TEMPLATE } from './types';

export function useComposerPrefill(
  sessionId: string | undefined,
  setMessage: (message: string) => void
): MutableRefObject<string | null> {
  const [searchParams, setSearchParams] = useSearchParams();
  const executeIdeaId = searchParams.get('executeIdea');
  const deployHelpEnvironment = searchParams.get('deployHelp');
  const deployHelpIntent = searchParams.get('deployIntent');
  const executeIdeaIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (executeIdeaId && !sessionId) {
      executeIdeaIdRef.current = executeIdeaId;
      setMessage(EXECUTE_IDEA_PROMPT_TEMPLATE.replace('{ideaId}', executeIdeaId));
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.delete('executeIdea');
          return next;
        },
        { replace: true }
      );
    }
  }, [executeIdeaId, sessionId, setMessage, setSearchParams]);

  useEffect(() => {
    if (deployHelpEnvironment === null || sessionId) return;
    const prompt = deployHelpPrompt(deployHelpEnvironment, deployHelpIntent);
    if (prompt) setMessage(prompt);
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete('deployHelp');
        next.delete('deployIntent');
        return next;
      },
      { replace: true }
    );
  }, [deployHelpEnvironment, deployHelpIntent, sessionId, setMessage, setSearchParams]);

  return executeIdeaIdRef;
}
