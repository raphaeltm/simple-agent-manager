import {gzipSync} from 'node:zlib';
// Verification-only: keep interpreter discovery and every invocation in one block.
export function pythonInvocationBlock(code, folder, phase) {
 if(typeof code!=='string'||!/^\/workspaces\/[a-zA-Z0-9/_-]+$/.test(folder)||!/^[a-z-]+$/.test(phase))throw new Error();
 const wrapped=`import pathlib,json,base64,gzip
out=pathlib.Path(${JSON.stringify(folder)});out.mkdir(parents=True,exist_ok=True,mode=0o700)
status=0
try:exec(compile(gzip.decompress(base64.b64decode(${JSON.stringify(gzipSync(code).toString('base64'))})),'<verification-phase>','exec'))
except SystemExit as error:status=error.code if isinstance(error.code,int) and 0<=error.code<=255 else 1
except BaseException:status=1
proof=out/${JSON.stringify(phase+'-invocation.json')}
proof.write_text(json.dumps({'interpreterExists':True,'invocationStatus':status}));proof.chmod(0o600)
`;
 const encoded=gzipSync(wrapped).toString('base64');
 return `{ sam_probe_python=''; for sam_probe_candidate in /opt/uv-python/*/bin/python3 /usr/bin/python3 /usr/local/bin/python3; do if [ -x "$sam_probe_candidate" ] && "$sam_probe_candidate" -c 'import sys;assert sys.executable.startswith("/")' >/dev/null 2>&1; then sam_probe_python="$sam_probe_candidate"; break; fi; done; if [ -n "$sam_probe_python" ]; then "$sam_probe_python" -c 'import base64,gzip;exec(gzip.decompress(base64.b64decode("${encoded}")))'; else /bin/mkdir -p '${folder}'; printf '%s\n' '{"interpreterExists":false,"invocationStatus":127}' > '${folder}/${phase}-invocation.json'; /bin/chmod 600 '${folder}/${phase}-invocation.json'; fi; } >/dev/null 2>&1`;
}

export function probeStepsScript(steps) {
 if(!Array.isArray(steps)||!steps.length||steps.some(s=>!s||typeof s.script!=='string'||!Array.isArray(s.args)||s.args.some(x=>typeof x!=='string')||typeof s.output!=='string'))throw new Error();
 return `import sys,subprocess,pathlib
for step in ${JSON.stringify(steps)}:
 output=pathlib.Path(step['output']);output.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
 with output.open('w') as stream:
  result=subprocess.run([sys.executable,step['script'],*step['args']],stdout=stream,stderr=subprocess.PIPE,timeout=60)
 output.chmod(0o600)
 if result.returncode!=0:raise SystemExit(result.returncode)
`;
}
