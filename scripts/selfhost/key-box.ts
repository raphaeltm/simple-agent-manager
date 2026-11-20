/**
 * The box as sealing sees it: `.env` with the recorded key choice applied (key-choice.ts), unless
 * `.env` names a provider itself. Every tool that asks "does this box seal, and how?" without
 * running a deploy reads it here.
 */
import { applyKeyChoice, explicitKeyProvider, readKeyChoice } from './key-choice.js';
import { keyAgentPort, keyServiceEnabled } from './key-service.js';

type Box = Readonly<Record<string, string>>;

export function effectiveKeyBox(box: Box, stateDir: string): Box {
  const choice = readKeyChoice(stateDir);
  return !explicitKeyProvider(box) && choice ? applyKeyChoice(box, choice) : box;
}

/** The key agent's loopback port when this box seals its secrets, else null. */
export function sealedKeyAgentPort(box: Box, stateDir: string): number | null {
  const effective = effectiveKeyBox(box, stateDir);
  return keyServiceEnabled(effective) ? keyAgentPort(effective) : null;
}
