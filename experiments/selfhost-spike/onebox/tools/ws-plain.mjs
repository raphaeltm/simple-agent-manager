import WebSocket from 'ws'; const ws = new WebSocket(process.argv[2]); let n = 0;
ws.on('open', () => ws.send('hi0')); ws.on('message', (m) => { console.log('recv', String(m)); if (++n < 2) ws.send('hi' + n); else ws.close(); });
ws.on('close', () => process.exit(0)); ws.on('error', (e) => { console.log('ERROR', e.message); process.exit(1); }); setTimeout(() => { console.log('TIMEOUT'); process.exit(2); }, 10000);
