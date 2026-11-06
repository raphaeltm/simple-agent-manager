import subprocess,time,json,threading,os,signal
from http.server import ThreadingHTTPServer,BaseHTTPRequestHandler
start=time.monotonic()
log=open('/root/dockerd.log','w')
daemon=subprocess.Popen(['dockerd-entrypoint.sh','dockerd','--iptables=false','--ip6tables=false','--ip-forward=false'],stdout=log,stderr=log)
ready=None
info=None
def boot():
 global ready,info
 for _ in range(120):
  p=subprocess.run(['docker','info','--format','{{json .}}'],capture_output=True,text=True)
  if p.returncode==0:
   ready=time.monotonic()-start; info=json.loads(p.stdout);break
  if daemon.poll()!=None:break
  time.sleep(.25)
threading.Thread(target=boot,daemon=True).start()
class Handler(BaseHTTPRequestHandler):
 def do_GET(self):
  data={'ready_seconds':ready,'daemon_exit':daemon.poll(),'info':info if ready else None,'log':open('/root/dockerd.log').read()}
  self.send_response(200);self.end_headers();self.wfile.write(json.dumps(data).encode())
class Server(ThreadingHTTPServer):
 def server_bind(self):
  self.socket.bind(self.server_address)
  self.server_name='spike';self.server_port=8080
Server(('0.0.0.0',8080),Handler).serve_forever()
