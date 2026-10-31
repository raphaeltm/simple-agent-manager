#!/usr/bin/env python3
"""Bounded offline ACP/provider/recovery probe against real release binaries.

Usage: python3 scripts/diagnostics/verify-opencode-acp.py /path/to/v2/opencode [--v1 /path/to/v1/opencode]
No real credentials or inference are used. HTTP is mocked at the provider boundary.
"""
import argparse
import http.server
import json
import os
import queue
import shutil
import subprocess
import tempfile
import threading
from pathlib import Path


PROMPT_METHOD = 'session/prompt'


class Provider(http.server.BaseHTTPRequestHandler):
    calls = []

    def log_message(self, *_args):
        # Keep the bounded probe output focused on ACP assertions, not HTTP access logs.
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        self.calls.append(body)
        assert self.headers['Authorization'] == 'Bearer local-probe-key'
        assert body['model'] == 'sam-probe'
        # Title generation is a separate, tool-free inference request.
        tools = body.get('tools', [])
        has_result = any(m.get('role') == 'tool' for m in body.get('messages', []))
        if tools and not has_result:
            read = next(t for t in tools if t['function']['name'] == 'read')
            properties = read['function']['parameters'].get('properties', {})
            field = 'path' if 'path' in properties else 'filePath'
            delta = {'role': 'assistant', 'tool_calls': [{'index': 0, 'id': 'probe-read',
                     'type': 'function', 'function': {'name': 'read', 'arguments': json.dumps({field: str(self.server.fixture)})}}]}
            finish = 'tool_calls'
        else:
            delta = {'role': 'assistant', 'content': 'SAM_V2_PROBE_OK'}
            finish = 'stop'
        chunks = [
            {'choices': [{'index': 0, 'delta': delta, 'finish_reason': None}]},
            {'choices': [{'index': 0, 'delta': {}, 'finish_reason': finish}],
             'usage': {'prompt_tokens': 10, 'completion_tokens': 5, 'total_tokens': 15}},
        ]
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.end_headers()
        self.wfile.write((''.join('data: ' + json.dumps(c) + '\n\n' for c in chunks) + 'data: [DONE]\n\n').encode())


class ACP:
    def __init__(self, binary, env, cwd):
        self.log = tempfile.TemporaryFile()
        self.p = subprocess.Popen([binary, 'acp'], env=env, cwd=cwd, stdin=subprocess.PIPE,
                                  stdout=subprocess.PIPE, stderr=self.log, text=True)
        self.messages = queue.Queue()
        self.notifications = []
        self.counter = 0
        threading.Thread(target=self.read, daemon=True).start()
        result = self.request('initialize', {'protocolVersion': 1, 'clientCapabilities': {},
                             'clientInfo': {'name': 'sam-compatibility-probe', 'version': '1'}})
        assert result['agentCapabilities']['loadSession']
        print('initialize:', result.get('agentInfo'))

    def read(self):
        for line in self.p.stdout:
            self.messages.put(json.loads(line))
        self.messages.put(None)

    def request(self, method, params):
        self.counter += 1
        ident = self.counter
        self.p.stdin.write(json.dumps({'jsonrpc': '2.0', 'id': ident, 'method': method, 'params': params}) + '\n')
        self.p.stdin.flush()
        while True:
            msg = self.messages.get(timeout=45)
            assert msg is not None, 'ACP process exited'
            if 'method' in msg:
                if 'id' in msg:
                    assert msg['method'] == 'session/request_permission', msg['method']
                    option = next(o for o in msg['params']['options'] if o['kind'] == 'allow_once')
                    self.p.stdin.write(json.dumps({'jsonrpc': '2.0', 'id': msg['id'],
                        'result': {'outcome': {'outcome': 'selected', 'optionId': option['optionId']}}}) + '\n')
                    self.p.stdin.flush()
                else:
                    self.notifications.append(msg)
                continue
            assert msg['id'] == ident
            assert 'error' not in msg, (method, msg.get('error'))
            print(method + ': OK')
            return msg['result']

    def close(self):
        self.p.stdin.close()
        try:
            self.p.wait(timeout=8)
        except subprocess.TimeoutExpired:
            self.p.kill()
            self.p.wait()
        self.p.stdout.close()
        self.log.close()


def assert_marker(process):
    assert any('SAM_V2_PROBE_OK' in str(m['params'].get('update', {}).get('content', {}))
               for m in process.notifications if m.get('method') == 'session/update'), 'missing assistant marker'


def assert_history(calls):
    assert any(any(m.get('role') == 'assistant' and 'SAM_V2_PROBE_OK' in str(m.get('content'))
                   for m in call.get('messages', [])) and
               any(m.get('role') == 'tool' and 'SAM_V2_PROBE_TOOL_RESULT' in str(m.get('content'))
                   for m in call.get('messages', [])) for call in calls), 'recovered request lost history'


def main():
    args = argparse.ArgumentParser()
    args.add_argument('binary')
    args.add_argument('--v1')
    options = args.parse_args()
    binary = str(Path(options.binary).resolve())
    with tempfile.TemporaryDirectory(prefix='sam-opencode-acp-') as tmp:
        root = Path(tmp)
        cwd = root / 'workspace'
        cwd.mkdir()
        fixture = cwd / 'fixture.txt'
        fixture.write_text('SAM_V2_PROBE_TOOL_RESULT\n')
        server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Provider)
        server.fixture = fixture
        threading.Thread(target=server.serve_forever, daemon=True).start()
        # Exact V1 provider shape from gateway.go: retain compatibility and prove
        # that v2 does not need the old ~/.cache/opencode/node_modules preinstall.
        config = {'model': 'custom/sam-probe', 'provider': {'custom': {
            'npm': '@ai-sdk/openai-compatible', 'name': 'Custom Provider',
            'options': {'baseURL': f'http://127.0.0.1:{server.server_port}/v1', 'apiKey': '{env:OPENCODE_API_KEY}'},
            'models': {'sam-probe': {'name': 'sam-probe'}}}}}
        env = {k: v for k, v in os.environ.items() if not k.startswith(('OPENCODE_', 'XDG_'))}
        env.update(HOME=str(root / 'home'), XDG_CONFIG_HOME=str(root / 'config'),
                   XDG_DATA_HOME=str(root / 'data'), XDG_CACHE_HOME=str(root / 'cache'),
                   XDG_STATE_HOME=str(root / 'state'), OPENCODE_API_KEY='local-probe-key',
                   OPENCODE_CONFIG_CONTENT=json.dumps(config), OPENCODE_DISABLE_AUTOUPDATE='true')
        processes = []
        try:
            first = ACP(str(Path(options.v1).resolve()) if options.v1 else binary, env, cwd)
            processes.append(first)
            session = first.request('session/new', {'cwd': str(cwd), 'mcpServers': []})['sessionId']
            prompt = {'sessionId': session, 'prompt': [{'type': 'text', 'text': 'Read fixture.txt with the read tool then say SAM_V2_PROBE_OK.'}]}
            first.request(PROMPT_METHOD, prompt)
            assert_marker(first)
            updates = [x['params'].get('update', {}) for x in first.notifications if x.get('method') == 'session/update']
            assert any(x.get('sessionUpdate') == 'tool_call' for x in updates), 'no tool call'
            first.close()
            processes.remove(first)
            second = ACP(binary, env, cwd)
            processes.append(second)
            second.request('session/load', {'sessionId': session, 'cwd': str(cwd), 'mcpServers': []})
            second.request('session/set_config_option', {'sessionId': session, 'configId': 'model', 'value': 'custom/sam-probe'})
            second.request('session/set_mode', {'sessionId': session, 'modeId': 'build'})
            baseline = len(Provider.calls)
            second.request(PROMPT_METHOD, prompt)
            assert_marker(second)
            assert_history(Provider.calls[baseline:])
            second.close()
            processes.remove(second)
            # Copy only the data directory to simulate snapshot restoration with
            # a cold cache. Keep cwd fixed: ACP explicitly validates the directory.
            shutil.copytree(root / 'data', root / 'restored-data')
            shutil.rmtree(root / 'cache', ignore_errors=True)
            env['XDG_DATA_HOME'] = str(root / 'restored-data')
            third = ACP(binary, env, cwd)
            processes.append(third)
            third.request('session/load', {'sessionId': session, 'cwd': str(cwd), 'mcpServers': []})
            baseline = len(Provider.calls)
            third.request(PROMPT_METHOD, prompt)
            assert_marker(third)
            assert_history(Provider.calls[baseline:])
            assert any(m.get('role') == 'tool' and 'SAM_V2_PROBE_TOOL_RESULT' in str(m.get('content'))
                       for call in Provider.calls for m in call.get('messages', [])), 'tool result never reached model'
            print('PASS: ACP, legacy custom config, env key, tool result, process recovery and cold-cache snapshot restore')
        finally:
            for process in processes:
                process.close()
            server.shutdown()
            server.server_close()


if __name__ == '__main__':
    main()
