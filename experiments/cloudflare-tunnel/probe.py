"""Bounded, staging-only named tunnel experiment. No real SAM data/credentials at origin.

All remote resources are uniquely named, journaled, and deleted in finally and in
an independent CI always-step. Only sanitized assertions go into report.json.
"""
import asyncio
import json
import os
from pathlib import Path
import secrets
import signal
import sys
import time

import aiohttp
from aiohttp import web

ROOT = Path(__file__).resolve().parent
OUT = ROOT / '.tmp'
OUT.mkdir(exist_ok=True)
STATE = OUT / 'resources.json'
REPORT = OUT / 'report.json'
API = 'https://api.cloudflare.com/client/v4'
CF = os.environ['CF_API_TOKEN']
ACCOUNT = os.environ['CF_ACCOUNT_ID']
ZONE = os.environ['CF_ZONE_ID']
DOMAIN = os.environ['BASE_DOMAIN']
RUN = os.environ['GITHUB_RUN_ID'] + '-' + os.environ.get('GITHUB_RUN_ATTEMPT', '1')
NAME = 'sam-tunnel-proof-' + RUN
state = json.loads(STATE.read_text()) if STATE.exists() else {'name': NAME, 'dns': [], 'routes': []}
report = json.loads(REPORT.read_text()) if REPORT.exists() else {
    'run': RUN, 'checks': [], 'scope': 'isolated CI origin and Worker in staging zone; not a managed SAM VM'}


def save():
    STATE.write_text(json.dumps(state, indent=2))
    REPORT.write_text(json.dumps(report, indent=2))


def record(name, passed, **details):
    row = {'name': name, 'passed': passed, **details}
    report['checks'].append(row)
    save()
    print(json.dumps(row), flush=True)


async def api(session, method, path, body=None, form=None):
    async with session.request(method, API + path,
                               headers={'Authorization': 'Bearer ' + CF},
                               json=body, data=form, timeout=aiohttp.ClientTimeout(total=45)) as response:
        data = await response.json(content_type=None)
        if response.status >= 400 or not data.get('success', False):
            # Cloudflare errors can include submitted secrets. Print codes only.
            codes = [e.get('code') for e in data.get('errors', [])]
            raise RuntimeError(f'Cloudflare {method} {path.split("/")[-1]} HTTP {response.status}, codes={codes}')
        return data.get('result')


async def cleanup(session):
    failures = []
    for key, prefix in [('routes', f'/zones/{ZONE}/workers/routes/'),
                        ('dns', f'/zones/{ZONE}/dns_records/')]:
        for item in list(state[key]):
            try:
                await api(session, 'DELETE', prefix + item)
                state[key].remove(item)
                save()
            except Exception as exc:
                failures.append(str(exc))
    if state.get('worker'):
        try:
            await api(session, 'DELETE', f'/accounts/{ACCOUNT}/workers/scripts/{state["worker"]}')
            del state['worker']
            save()
        except Exception as exc:
            failures.append(str(exc))
    if state.get('tunnel'):
        try:
            tid = state['tunnel']
            await api(session, 'DELETE', f'/accounts/{ACCOUNT}/cfd_tunnel/{tid}/connections')
            await api(session, 'DELETE', f'/accounts/{ACCOUNT}/cfd_tunnel/{tid}')
            del state['tunnel']
            save()
        except Exception as exc:
            failures.append(str(exc))
    record('cleanup', not failures, errors=failures)
    return not failures


async def main():
    if os.environ.get('DEPLOY_ENVIRONMENT') != 'staging' or DOMAIN != 'sammy.party':
        raise RuntimeError('This experiment is restricted to the SAM staging zone')
    async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=20), cookie_jar=aiohttp.DummyCookieJar()) as session:
        if '--cleanup' in sys.argv:
            return 0 if await cleanup(session) else 1
        if state.get('tunnel') or state.get('worker') or state['dns'] or state['routes']:
            raise RuntimeError('Previous resources remain; run cleanup before retry')
        origin_key, probe_key = secrets.token_urlsafe(32), secrets.token_urlsafe(32)
        proc = None
        servers = []
        vm_host, flat_host, edge_host = f'{NAME}.vm.{DOMAIN}', f'{NAME}-origin.{DOMAIN}', f'{NAME}.{DOMAIN}'
        token_path = OUT / 'tunnel-token'
        connector_log = None
        agent_proc = None
        agent_log = None
        agent_tokens_path = OUT / 'agent-tokens.json'

        async def origin(request):
            if request.headers.get('Authorization') != 'Bearer ' + origin_key:
                return web.Response(status=401)
            if request.path == '/stream':
                response = web.StreamResponse(headers={'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store'})
                await response.prepare(request)
                await response.write(b'data: first\n\n')
                await asyncio.sleep(2)
                await response.write(b'data: last\n\n')
                return response
            if request.path.endswith('/ws'):
                ws = web.WebSocketResponse(autoping=False)
                await ws.prepare(request)
                async for message in ws:
                    if message.type == aiohttp.WSMsgType.TEXT:
                        await ws.send_str(message.data)
                    elif message.type == aiohttp.WSMsgType.BINARY:
                        await ws.send_bytes(message.data)
                return ws
            if request.path.startswith('/ports/'):
                port = request.path.split('/')[2]
                if port not in ('3000', '5173'):
                    return web.Response(status=404)
                # Mirrors the transport shape: one ingress, local HTTP ports behind it.
                async with session.get(f'http://127.0.0.1:{port}/') as upstream:
                    return web.Response(body=await upstream.read(), content_type='application/json')
            return web.json_response({'origin': NAME, 'path': request.path,
                                      'remoteLoopback': request.remote in ('127.0.0.1', '::1'),
                                      'samRelayMarker': bool(request.headers.get('X-SAM-Proxied-Request')),
                                      'forwardedHostPresent': bool(request.headers.get('X-Forwarded-Host')),
                                      'probeKeyLeaked': 'X-Probe-Key' in request.headers})

        async def start_server(port, handler):
            app = web.Application()
            app.router.add_route('*', '/{tail:.*}', handler)
            runner = web.AppRunner(app, access_log=None)
            await runner.setup()
            await web.TCPSite(runner, '127.0.0.1', port).start()
            servers.append(runner)

        async def start_connector():
            return await asyncio.create_subprocess_exec(
                str(OUT / 'cloudflared'), 'tunnel', '--no-autoupdate', '--loglevel', 'error',
                '--protocol', 'http2', 'run', '--token-file', str(token_path),
                stdout=connector_log, stderr=connector_log)

        async def get(url, headers=None):
            try:
                async with session.get(url, headers=headers, allow_redirects=False) as response:
                    raw = await response.text()
                    try:
                        body = json.loads(raw)
                    except ValueError:
                        body = None
                    return response.status, body, None
            except (aiohttp.ClientError, asyncio.TimeoutError) as exc:
                return None, None, type(exc).__name__

        async def wait_origin(url, headers):
            for _ in range(30):
                status, body, error = await get(url, headers)
                if status == 200 and body and body.get('origin') == NAME:
                    return True
                await asyncio.sleep(2)
            record('origin-readiness', False, status=status, error=error)
            return False

        try:
            agent_log = (OUT / 'agent-private.log').open('w')
            agent_tokens_path.unlink(missing_ok=True)
            agent_env = {'PATH': os.environ['PATH'], 'HOME': os.environ['HOME'], 'TUNNEL_PROOF_TOKENS': str(agent_tokens_path)}
            agent_proc = await asyncio.create_subprocess_exec(str(OUT / 'agent-proof.test'), '-test.run=^TestTunnelProofHost$', '-test.timeout=8m',
                                                             env=agent_env, stdout=agent_log, stderr=agent_log)
            for _ in range(30):
                if agent_tokens_path.exists():
                    break
                if agent_proc.returncode is not None:
                    raise RuntimeError('Agent fixture exited before readiness')
                await asyncio.sleep(1)
            agent_tokens = json.loads(agent_tokens_path.read_text())
            zone = await api(session, 'GET', f'/zones/{ZONE}')
            if zone['name'] != DOMAIN:
                raise RuntimeError('Zone ID does not match staging domain')
            existing_routes = await api(session, 'GET', f'/zones/{ZONE}/workers/routes')
            record('existing-vm-route-exclusion', any(r['pattern'] == f'*.vm.{DOMAIN}/*' and not r.get('script') for r in existing_routes))
            tunnel = await api(session, 'POST', f'/accounts/{ACCOUNT}/cfd_tunnel', {'name': NAME, 'config_src': 'cloudflare'})
            state['tunnel'] = tunnel['id']
            save()
            record('updated-token-can-create-named-tunnel', True)
            token_path.touch(mode=0o600)
            token_path.write_text(tunnel['token'])
            await api(session, 'PUT', f'/accounts/{ACCOUNT}/cfd_tunnel/{state["tunnel"]}/configurations', {
                'config': {'ingress': [
                    rule for host in (vm_host, flat_host) for rule in (
                        {'hostname': host, 'path': '^/agent/', 'service': 'http://127.0.0.1:9010'},
                        {'hostname': host, 'service': 'http://127.0.0.1:9000'})
                ] + [{'service': 'http_status:404'}]}})
            for host in (vm_host, flat_host, edge_host):
                dns = await api(session, 'POST', f'/zones/{ZONE}/dns_records', {
                    'type': 'CNAME', 'name': host, 'content': state['tunnel'] + '.cfargotunnel.com',
                    'proxied': True, 'ttl': 1, 'comment': 'Isolated SAM tunnel experiment ' + RUN})
                state['dns'].append(dns['id'])
                save()
            # Existing .vm exclusion is observed, never modified. Flat fallback gets its own exact exclusion.
            route = await api(session, 'POST', f'/zones/{ZONE}/workers/routes', {'pattern': flat_host + '/*'})
            state['routes'].append(route['id'])
            save()
            metadata = {'main_module': 'worker.js', 'compatibility_date': '2026-11-01', 'bindings': [
                {'name': key, 'type': 'secret_text' if key.endswith(('_KEY', '_TOKENS')) else 'plain_text', 'text': value}
                for key, value in {'PROBE_KEY': probe_key, 'ORIGIN_KEY': origin_key, 'VM_HOST': vm_host, 'FLAT_HOST': flat_host,
                                   'AGENT_TOKENS': json.dumps(agent_tokens)}.items()]}
            form = aiohttp.FormData()
            form.add_field('metadata', json.dumps(metadata), content_type='application/json')
            form.add_field('worker.js', (ROOT / 'probe-worker.js').read_text(), filename='worker.js', content_type='application/javascript+module')
            # Journal the deterministic name before upload, including interrupted HTTP responses.
            state['worker'] = NAME
            save()
            await api(session, 'PUT', f'/accounts/{ACCOUNT}/workers/scripts/{NAME}', form=form)
            route = await api(session, 'POST', f'/zones/{ZONE}/workers/routes', {'pattern': edge_host + '/*', 'script': NAME})
            state['routes'].append(route['id'])
            save()
            await start_server(9000, origin)
            for port in (3000, 5173):
                async def preview(request, value=port):
                    if request.path == '/ws':
                        ws = web.WebSocketResponse()
                        await ws.prepare(request)
                        async for message in ws:
                            if message.type == aiohttp.WSMsgType.TEXT:
                                await ws.send_str(message.data)
                        return ws
                    return web.json_response({'port': value, 'tokenLeaked': 'token' in request.query,
                                              'authorizationLeaked': 'Authorization' in request.headers})
                await start_server(port, preview)
            connector_log = (OUT / 'connector-private.log').open('w')
            proc = await start_connector()
            auth = {'X-Probe-Key': probe_key}
            edge = 'https://' + edge_host
            if not await wait_origin(edge + '/flat/443/health', auth):
                raise RuntimeError('Flat hostname routing did not become ready')
            for variant, host in [('vm', vm_host), ('flat', flat_host)]:
                for port in (443, 8443):
                    status, body, error = await get(f'{edge}/{variant}/{port}/health', auth)
                    record(f'worker-{variant}-{port}', status == 200 and bool(body) and body.get('origin') == NAME,
                           status=status, error=error, origin_observation=body if status == 200 else None)
                    status, body, error = await get(f'https://{host}:{port}/health', {'Authorization': 'Bearer ' + origin_key})
                    record(f'direct-{variant}-{port}-verified-tls', status == 200 and bool(body) and body.get('origin') == NAME,
                           status=status, error=error, origin_observation=body if status == 200 else None)
            status, _, _ = await get(edge + '/flat/443/health')
            record('worker-rejects-unauthenticated', status == 401, status=status)
            status, _, _ = await get('https://' + flat_host + '/health')
            record('origin-rejects-direct-unauthenticated', status == 401, status=status)
            checks = await asyncio.gather(*(get(edge + '/flat/443/ports/' + str(p), auth) for p in (3000, 5173)))
            record('two-local-http-ports-one-tunnel', all(s == 200 and b and b['port'] == p for (s, b, e), p in zip(checks, (3000, 5173))))
            agent_base = edge + '/flat/443/agent/workspaces/proof-ws/ports/'
            for port in (3000, 5173):
                status, body, error = await get(agent_base + str(port) + '/', auth)
                record(f'real-agent-port-{port}-jwt-and-token-stripping', status == 200 and body == {
                    'port': port, 'tokenLeaked': False, 'authorizationLeaked': False}, status=status, error=error)
            for mode in ('missing', 'invalid', 'expired', 'wrong_workspace', 'wrong_node'):
                status, _, error = await get(agent_base + '3000/', {**auth, 'X-Probe-Auth-Mode': mode})
                record('real-agent-rejects-' + mode, status in (401, 403), status=status, error=error)
            status, _, error = await get('https://' + flat_host + '/agent/workspaces/proof-ws/ports/3000/')
            record('real-agent-direct-without-jwt-rejected', status == 401, status=status, error=error)
            status, _, error = await get(agent_base + '9010/', auth)
            record('real-agent-refuses-proxy-to-own-listener', status == 403, status=status, error=error)
            # Public tunnel ingress cannot claim to be a local Git helper, even
            # without Worker-added headers. No real GitHub credential is used.
            status, _, error = await get('https://' + flat_host + '/agent/git-credential?workspaceId=proof-ws')
            record('tunnel-listener-blocks-bearerless-git-credential', status == 401, status=status, error=error)
            async with session.get('http://127.0.0.1:9011/git-credential?workspaceId=proof-ws') as response:
                body = await response.text()
                record('private-local-git-helper-still-works', response.status == 200 and 'synthetic-not-a-github-token' in body,
                       status=response.status)
            # Authenticated preview forwarding must not turn the private listener
            # back into a credential oracle; existing proxy relay marking applies.
            status, _, error = await get(agent_base + '9011/git-credential?workspaceId=proof-ws', auth)
            record('preview-to-private-git-helper-rejected', status == 401, status=status, error=error)
            async with session.ws_connect(agent_base + '5173/ws', headers=auth, heartbeat=None) as ws:
                await ws.send_str('real-agent-preview-websocket')
                message = await ws.receive(timeout=10)
                record('real-agent-preview-websocket', message.data == 'real-agent-preview-websocket')
            started = time.monotonic()
            async with session.get(edge + '/flat/443/stream', headers=auth) as response:
                first = await response.content.readline()
                first_at = time.monotonic() - started
                remainder = await response.read()
                record('streaming-first-byte-before-completion', first == b'data: first\n' and b'data: last' in remainder and first_at < 2,
                       first_byte_seconds=round(first_at, 3), total_seconds=round(time.monotonic() - started, 3))
            async with session.ws_connect(edge + '/flat/443/ws', headers=auth, autoping=False, heartbeat=None) as ws:
                await ws.send_str('before-idle')
                before = await ws.receive(timeout=10)
                await asyncio.sleep(35)
                await ws.send_bytes(b'after-idle')
                after = await ws.receive(timeout=10)
                record('websocket-text-binary-and-35s-idle', before.data == 'before-idle' and after.data == b'after-idle')
            proc.terminate()
            await asyncio.wait_for(proc.wait(), 15)
            proc = None
            await asyncio.sleep(3)
            status, _, _ = await get(edge + '/flat/443/health', auth)
            record('connector-stopped-no-direct-ip-fallback', status != 200, status=status)
            proc = await start_connector()
            record('connector-restart-same-tunnel-and-dns', await wait_origin(edge + '/flat/443/health', auth))
        except Exception as exc:
            record('experiment-error', False, error=str(exc) if isinstance(exc, RuntimeError) else type(exc).__name__)
        finally:
            if proc and proc.returncode is None:
                proc.terminate()
                try:
                    await asyncio.wait_for(proc.wait(), 15)
                except asyncio.TimeoutError:
                    proc.kill()
                    await proc.wait()
            for runner in servers:
                await runner.cleanup()
            if connector_log:
                connector_log.close()
            if agent_proc and agent_proc.returncode is None:
                agent_proc.terminate()
                await agent_proc.wait()
            if agent_log:
                agent_log.close()
            token_path.unlink(missing_ok=True)
            agent_tokens_path.unlink(missing_ok=True)
            await cleanup(session)
        # .vm TLS/8443 comparisons are measured findings, not prerequisites for flat :443 viability.
        required = [r for r in report['checks'] if not r['name'].startswith(('worker-vm-', 'direct-vm-', 'worker-flat-8443', 'direct-flat-8443'))]
        return 0 if required and all(r['passed'] for r in required) else 1


if __name__ == '__main__':
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    task = loop.create_task(main())
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, task.cancel)
    sys.exit(loop.run_until_complete(task))
