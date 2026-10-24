/**
 * Pre-fills the new-chat composer from a link, then removes the parameters so a reload does
 * not fill it again.
 *
 * `?deployHelp=<environment>&deployIntent=fix|deploy` is the Deployments page's "Ask an
 * agent". Only a valid environment name reaches the template (`deployHelpPrompt`), so a link
 * cannot put arbitrary text in the composer.
 *
 * There used to be an `?executeIdea=<id>` branch here too. Starting work on an idea no longer
 * goes through the composer at all: the idea page's Start work sheet submits it, and the
 * server links the idea to the new chat before the agent's first prompt rather than the
 * browser linking it afterwards. Nothing returns an idea ID from this hook any more.
 */
import { useEffect } from 'react';
import { useSearchParams } from 'react-router';

import { deployHelpPrompt } from './types';

export function useComposerPrefill(
  sessionId: string | undefined,
  setMessage: (message: string) => void
): void {
  const [searchParams, setSearchParams] = useSearchParams();
  const deployHelpEnvironment = searchParams.get('deployHelp');
  const deployHelpIntent = searchParams.get('deployIntent');

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
}
