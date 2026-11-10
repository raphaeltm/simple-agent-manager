# Slow WebSocket reader: handshake, ask the node to flood N MiB, stop reading for PAUSE s
# (TCP backpressure builds up behind us), then drain and report what arrived and how it closed.
# Usage: python3 -I ws-slow-reader.py HOST PORT PATH MIB PAUSE
import base64, os, socket, struct, sys, time
host, port, path, mib, pause = sys.argv[1], int(sys.argv[2]), sys.argv[3], int(sys.argv[4]), float(sys.argv[5])
s = socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 16384); s.connect((host, port))
if port == 443:
    import ssl; ctx = ssl.create_default_context(cafile=os.environ.get('SPIKE_CA')); s = ctx.wrap_socket(s, server_hostname=host)
key = base64.b64encode(os.urandom(16)).decode()
s.sendall(f"GET {path} HTTP/1.1\r\nHost: {host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n".encode())
buf = b''
while b'\r\n\r\n' not in buf: buf += s.recv(4096)
head, buf = buf.split(b'\r\n\r\n', 1); print(head.split(b'\r\n')[0].decode(), flush=True)
def send_text(t):
    p = t.encode(); mask = os.urandom(4)
    s.sendall(bytes([0x81, 0x80 | len(p)]) + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(p)))
def read_exact(n):
    global buf
    while len(buf) < n:
        d = s.recv(65536)
        if not d: raise EOFError
        buf += d
    out, buf = buf[:n], buf[n:]; return out
def read_frame():
    b1, b2 = read_exact(2); n = b2 & 0x7f
    if n == 126: n = struct.unpack('>H', read_exact(2))[0]
    elif n == 127: n = struct.unpack('>Q', read_exact(8))[0]
    return b1 & 0x0f, read_exact(n)
read_frame()  # hello
send_text(f"flood:{mib}"); t0 = time.time(); print(f"requested flood {mib} MiB; not reading for {pause}s", flush=True)
time.sleep(pause)
got = 0; s.settimeout(30)
try:
    while True:
        op, data = read_frame()
        if op == 2: got += len(data)
        elif op == 1: print("text:", data[:40], flush=True); break
        elif op == 8:
            code = struct.unpack('>H', data[:2])[0] if len(data) >= 2 else None
            print(f"CLOSE frame code={code} reason={data[2:]!r}", flush=True); break
except Exception as e: print("read ended:", type(e).__name__, e, flush=True)
print(f"received {got} of {mib*1048576} bytes ({got/1048576:.2f} MiB) in {time.time()-t0:.1f}s", flush=True)
