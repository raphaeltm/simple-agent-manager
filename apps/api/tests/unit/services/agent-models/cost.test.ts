import type { AgentModelPrice } from '@simple-agent-manager/shared';
import { describe, expect, it } from 'vitest';

import {
  classifyPrice,
  costMicroUsd,
  estimateReservationQuantities,
  type Quantities,
  reportedQuantities,
} from '../../../../src/services/agent-models/cost';

function price(unit: string, usd: number): AgentModelPrice {
  return { unit, usd };
}

describe('classifyPrice', () => {
  // Real catalog prices (apps/api/tests/fixtures/workers-ai-catalog.json), one per unit label
  // Cloudflare actually publishes today.
  it('classifies "per M input tokens" (clef-flash)', () => {
    expect(classifyPrice(price('per M input tokens', 0.038))).toEqual({
      measure: 'input-tokens',
      usdPerUnit: 0.038 / 1_000_000,
    });
  });

  it('classifies "per M output tokens" (glm-5.3)', () => {
    expect(classifyPrice(price('per M output tokens', 4.4))).toEqual({
      measure: 'output-tokens',
      usdPerUnit: 4.4 / 1_000_000,
    });
  });

  it('classifies "per M cached input tokens" (glm-5.3)', () => {
    expect(classifyPrice(price('per M cached input tokens', 0.26))).toEqual({
      measure: 'cached-input-tokens',
      usdPerUnit: 0.26 / 1_000_000,
    });
  });

  it('classifies "per audio minute" (whisper-large-v3-turbo)', () => {
    expect(classifyPrice(price('per audio minute', 0.000513))).toEqual({
      measure: 'audio-minutes',
      usdPerUnit: 0.000513,
    });
  });

  it('classifies "per audio minute (websocket)" as null even though it contains "audio minute"', () => {
    // deepgram/flux. The websocket check must run before the audio-minute substring check,
    // or this would be misclassified as a billable audio-minutes price.
    expect(classifyPrice(price('per audio minute (websocket)', 0.0077))).toBeNull();
  });

  it('classifies "per 1k characters" (deepgram/aura-1)', () => {
    expect(classifyPrice(price('per 1k characters', 0.015))).toEqual({
      measure: 'characters',
      usdPerUnit: 0.015 / 1000,
    });
  });

  it('classifies "per 512 by 512 tile" (leonardo/phoenix-1.0)', () => {
    expect(classifyPrice(price('per 512 by 512 tile', 0.00583))).toEqual({
      measure: 'tiles',
      usdPerUnit: 0.00583,
    });
  });

  it('classifies "per step" (leonardo/phoenix-1.0)', () => {
    expect(classifyPrice(price('per step', 0.00011))).toEqual({
      measure: 'steps',
      usdPerUnit: 0.00011,
    });
  });

  it('classifies "per inference request" (resnet-50)', () => {
    expect(classifyPrice(price('per inference request', 2.51e-6))).toEqual({
      measure: 'requests',
      usdPerUnit: 2.51e-6,
    });
  });

  it('classifies an unknown unit as null', () => {
    expect(classifyPrice(price('per fortnight', 1))).toBeNull();
  });
});

describe('estimateReservationQuantities', () => {
  const defaults = { reservationOutputTokens: 777 };

  it('estimates input-tokens as ceil(text chars / 3) for plain text', () => {
    const quantities = estimateReservationQuantities(
      { prompt: 'Hello world, this is a 33-char prompt!!' },
      defaults
    );
    expect(quantities['input-tokens']).toBe(13);
    expect(quantities.characters).toBe(39);
  });

  it('counts a long base64-looking media blob as a fixed token block, not as text', () => {
    const base64Blob = 'A'.repeat(400_000);
    const quantities = estimateReservationQuantities(
      { prompt: 'short text', audio: base64Blob },
      defaults
    );
    // 2000 fixed tokens for the blob + ceil(10 / 3) for "short text" — the 400,000-char
    // blob contributes nothing to the character-based text estimate.
    expect(quantities['input-tokens']).toBe(2004);
    expect(quantities.characters).toBe(10);
    expect(quantities['audio-minutes']).toBe(2);
  });

  it('counts a long int array as media, not as a nested value to recurse into', () => {
    const intArray = new Array(5000).fill(0);
    const quantities = estimateReservationQuantities({ text: 'hi', samples: intArray }, defaults);
    expect(quantities['input-tokens']).toBe(2001);
    expect(quantities.characters).toBe(2);
  });

  it('prefers max_tokens over max_completion_tokens and max_output_tokens', () => {
    const quantities = estimateReservationQuantities(
      { prompt: 'x', max_tokens: 10, max_completion_tokens: 20, max_output_tokens: 30 },
      defaults
    );
    expect(quantities['output-tokens']).toBe(10);
  });

  it('falls back to max_completion_tokens when max_tokens is absent', () => {
    const quantities = estimateReservationQuantities(
      { prompt: 'x', max_completion_tokens: 20, max_output_tokens: 30 },
      defaults
    );
    expect(quantities['output-tokens']).toBe(20);
  });

  it('falls back to max_output_tokens when the other two are absent', () => {
    const quantities = estimateReservationQuantities(
      { prompt: 'x', max_output_tokens: 30 },
      defaults
    );
    expect(quantities['output-tokens']).toBe(30);
  });

  it('falls back to the default reservation when no max-tokens field is set', () => {
    const quantities = estimateReservationQuantities({ prompt: 'x' }, defaults);
    expect(quantities['output-tokens']).toBe(777);
  });

  it('ignores a non-positive max_tokens and falls back to the default reservation', () => {
    const quantities = estimateReservationQuantities({ prompt: 'x', max_tokens: 0 }, defaults);
    expect(quantities['output-tokens']).toBe(777);
  });

  it('defaults image tiles to a 1024x1024 image when width/height are omitted', () => {
    expect(estimateReservationQuantities({}, defaults).tiles).toBe(4);
  });

  it('computes image tiles from an explicit width and height', () => {
    expect(estimateReservationQuantities({ width: 512, height: 512 }, defaults).tiles).toBe(1);
  });

  it('computing tiles from an explicit 1024x1024 matches the default', () => {
    expect(estimateReservationQuantities({ width: 1024, height: 1024 }, defaults).tiles).toBe(4);
  });

  it('reserves num_steps when set', () => {
    expect(estimateReservationQuantities({ num_steps: 12 }, defaults).steps).toBe(12);
  });

  it('falls back to steps when num_steps is absent', () => {
    expect(estimateReservationQuantities({ steps: 8 }, defaults).steps).toBe(8);
  });

  it('reserves the default step count when neither field is set', () => {
    expect(estimateReservationQuantities({}, defaults).steps).toBe(50);
  });
});

describe('reportedQuantities', () => {
  const reserved: Quantities = {
    'input-tokens': 99,
    'output-tokens': 88,
    'audio-minutes': 1,
    characters: 1,
    tiles: 4,
    steps: 50,
    requests: 1,
  };

  it('reads OpenAI-style usage', () => {
    const quantities = reportedQuantities(
      { usage: { prompt_tokens: 120, completion_tokens: 45 } },
      reserved,
      { outputChars: 999 }
    );
    expect(quantities['input-tokens']).toBe(120);
    expect(quantities['output-tokens']).toBe(45);
  });

  it('reads cached tokens from prompt_tokens_details', () => {
    const quantities = reportedQuantities(
      {
        usage: {
          prompt_tokens: 100,
          completion_tokens: 20,
          prompt_tokens_details: { cached_tokens: 30 },
        },
      },
      reserved,
      { outputChars: 999 }
    );
    expect(quantities['cached-input-tokens']).toBe(30);
    expect(quantities['input-tokens']).toBe(100);
  });

  it('sums Clairic usage (state_tokens + schema_tokens + image_tokens) as input-tokens', () => {
    const quantities = reportedQuantities(
      { usage: { state_tokens: 10, schema_tokens: 5, image_tokens: 3 } },
      reserved,
      { outputChars: 30 }
    );
    expect(quantities['input-tokens']).toBe(18);
    // No completion_tokens/output_tokens reported either, so output is still estimated.
    expect(quantities['output-tokens']).toBe(10);
  });

  it('converts Whisper transcription_info.duration (seconds) to audio-minutes', () => {
    const quantities = reportedQuantities(
      { text: 'hello', transcription_info: { duration: 90 } },
      reserved,
      { outputChars: 30 }
    );
    expect(quantities['audio-minutes']).toBe(1.5);
  });

  it('estimates output-tokens from outputChars when no usage is reported', () => {
    const quantities = reportedQuantities({ text: 'a plain text response' }, reserved, {
      outputChars: 39,
    });
    expect(quantities['output-tokens']).toBe(13);
    // Everything else is untouched from the reservation.
    expect(quantities['input-tokens']).toBe(99);
    expect(quantities['audio-minutes']).toBe(1);
  });
});

describe('costMicroUsd', () => {
  it('bills cached input tokens once, at the cached rate, not also at the input rate', () => {
    // glm-5.3: input $1.40/M, output $4.40/M, cached $0.26/M
    const glm53 = [
      price('per M input tokens', 1.4),
      price('per M output tokens', 4.4),
      price('per M cached input tokens', 0.26),
    ];
    const result = costMicroUsd(
      glm53,
      { 'input-tokens': 1_000_000, 'cached-input-tokens': 200_000, 'output-tokens': 500_000 },
      999
    );
    // (1,000,000 - 200,000) * 1.4/1e6 + 500,000 * 4.4/1e6 + 200,000 * 0.26/1e6, in micro-USD, ceiled.
    expect(result).toBe(3_372_001);
  });

  it('clamps the input-token quantity at zero when cached tokens exceed reported input tokens', () => {
    const glm53 = [
      price('per M input tokens', 1.4),
      price('per M output tokens', 4.4),
      price('per M cached input tokens', 0.26),
    ];
    const result = costMicroUsd(
      glm53,
      { 'input-tokens': 100, 'cached-input-tokens': 150, 'output-tokens': 0 },
      999
    );
    // input-tokens quantity clamps to max(0, 100 - 150) = 0; only the cached-rate charge remains.
    expect(result).toBe(39);
  });

  it('ignores reported cached tokens entirely for a model with no cached-token price', () => {
    // clef-flash only publishes an input-token price.
    const clefFlash = [price('per M input tokens', 0.038)];
    const result = costMicroUsd(
      clefFlash,
      { 'input-tokens': 1_000_000, 'cached-input-tokens': 999_999 },
      999
    );
    // No cached-tokens price exists for this model, so the input quantity is NOT reduced,
    // even though a (meaningless) cached-tokens quantity was reported.
    expect(result).toBe(38_000);
  });

  it('bills audio minutes', () => {
    // openai/whisper-large-v3-turbo
    const whisperTurbo = [price('per audio minute', 0.000513)];
    expect(costMicroUsd(whisperTurbo, { 'audio-minutes': 10 }, 999)).toBe(5130);
  });

  it('bills characters', () => {
    // deepgram/aura-1
    const auraTts = [price('per 1k characters', 0.015)];
    expect(costMicroUsd(auraTts, { characters: 500 }, 999)).toBe(7500);
  });

  it('bills tiles and steps together for an image model', () => {
    // leonardo/phoenix-1.0
    const phoenix = [price('per 512 by 512 tile', 0.00583), price('per step', 0.00011)];
    expect(costMicroUsd(phoenix, { tiles: 4, steps: 30 }, 999)).toBe(26_620);
  });

  it('falls back to the unpriced amount when the model has no usable published price', () => {
    expect(costMicroUsd([], { 'input-tokens': 999_999 }, 500)).toBe(500);
  });

  it('charges a minimum of 1 microUSD for a priced call, even with all-zero quantities', () => {
    const clefFlash = [price('per M input tokens', 0.038)];
    expect(costMicroUsd(clefFlash, {}, 999)).toBe(1);
  });

  it('rounds the total cost up to the next whole microUSD', () => {
    // gemma-4-26b-a4b-it: input $0.10/M, output $0.30/M. 7 input + 3 output tokens produces a
    // sub-microUSD fractional total (1.6 microUSD) that must round UP to 2, not down to 1.
    const gemma = [price('per M input tokens', 0.1), price('per M output tokens', 0.3)];
    expect(costMicroUsd(gemma, { 'input-tokens': 7, 'output-tokens': 3 }, 999)).toBe(2);
  });

  it('charges a minimum of 1 microUSD even for an extremely cheap priced call', () => {
    // resnet-50: $0.00000251 per inference request.
    const resnet = [price('per inference request', 2.51e-6)];
    expect(costMicroUsd(resnet, { requests: 1 }, 999)).toBe(3);
  });
});
