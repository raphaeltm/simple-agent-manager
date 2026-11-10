#!/usr/bin/env node
// Throwaway OpenAI-compatible chat/completions mock (streaming + non-streaming) for the spike.
// usage: node mock-llm.mjs [port]   -- logs each request body summary to stdout.
import http from 'node:http';
const port = Number(process.argv[2] ?? 9200);
http.createServer(async (req, res) => {
  let body = '';
  for await (const c of req) body += c;
  let j = {};
  try { j = JSON.parse(body); } catch {}
  console.log(new Date().toISOString(), req.method, req.url, 'model=', j.model, 'stream=', j.stream, 'msgs=', j.messages?.length, 'tools=', j.tools?.length ?? 0);
  if (!req.url.endsWith('/chat/completions')) { res.writeHead(404).end(); return; }
  const text = 'Hello from the local mock LLM behind celld.';
  const lastUser = [...(j.messages ?? [])].reverse().find((m) => m.role === 'user');
  const hadTool = (j.messages ?? []).some((m) => m.role === 'tool');
  const wantTool = typeof lastUser?.content === 'string' && lastUser.content.includes('TOOL:') && !hadTool;
  if (j.tools) console.log('  tools:', j.tools.map((t) => t.function?.name).join(','));
  if (hadTool) console.log('  tool result seen:', JSON.stringify((j.messages ?? []).filter((m) => m.role === 'tool').at(-1)).slice(0, 400));
  if (wantTool && j.stream) {
    const [, name, argJson = '{}'] = lastUser.content.match(/TOOL:(\S+)\s*(\{.*\})?/) ?? [];
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const base = { id: 'chatcmpl-tool', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: j.model };
    const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    send({ ...base, choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name, arguments: '' } }] }, finish_reason: null }] });
    send({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: argJson } }] }, finish_reason: null }] });
    send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } });
    res.write('data: [DONE]\n\n');
    res.end();
    return;
  }
  const id = 'chatcmpl-spike';
  const usage = { prompt_tokens: 12, completion_tokens: 9, total_tokens: 21 };
  if (!j.stream) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: j.model, choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }], usage }));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
  const base = { id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: j.model };
  send({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] });
  for (const word of text.split(' ')) {
    send({ ...base, choices: [{ index: 0, delta: { content: word + ' ' }, finish_reason: null }] });
    await new Promise((r) => setTimeout(r, 30));
  }
  send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage });
  res.write('data: [DONE]\n\n');
  res.end();
}).listen(port, '127.0.0.1', () => console.log('mock llm on', port));
