// Throwaway: WebSocket echo server standing in for a VM agent endpoint. usage: node ws-echo-server.cjs <wsModulePath> [port]
const { WebSocketServer } = require(process.argv[2]);
const port = Number(process.argv[3] ?? 9300);
const wss = new WebSocketServer({ host: '127.0.0.1', port });
wss.on('connection', (ws, req) => {
  console.log('conn', req.url);
  ws.on('message', (m) => ws.send('echo:' + m));
});
console.log('ws echo on', port);
