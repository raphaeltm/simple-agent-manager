const MODEL = '@cf/google/gemma-4-26b-a4b-it';

export function modelReply(
  text = 'Hello from the actual Mastra runtime',
  stream = false
): Response {
  const base = { id: 'completion-test', model: MODEL, created: 1 };
  if (stream) {
    return new Response(
      [
        {
          ...base,
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }],
        },
        {
          ...base,
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 7, total_tokens: 17 },
        },
      ]
        .map((event) => `data: ${JSON.stringify(event)}\n\n`)
        .join('') + 'data: [DONE]\n\n',
      {
        headers: { 'content-type': 'text/event-stream' },
      }
    );
  }
  return Response.json({
    ...base,
    object: 'chat.completion',
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 7, total_tokens: 17 },
  });
}
