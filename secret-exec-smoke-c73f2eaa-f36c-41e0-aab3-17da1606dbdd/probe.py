import hashlib, json, os, pathlib, socket, sys
MODE = sys.argv[1]
SELECTED = "SECRET_EXEC_SMOKE_SELECTED"
OTHER = "SECRET_EXEC_SMOKE_OTHER"
EXPECTED_HASH = "17072425dc839241ace91e282a2a0153ba014e76fcd4c95f79d26cd0943d743a"
MARKER = "secret-exec-smoke-c73f2eaa-f36c-41e0-aab3-17da1606dbdd"
def placeholder(name):
    return '__SAM_SECRET_REQUIRES_EXEC_WITH_SECRETS__' + name + '__'
def emit(checks):
    print(json.dumps({'marker': MARKER, 'mode': MODE, 'checks': checks}, sort_keys=True))
    if not all(checks.values()):
        sys.exit(1)
identity = {'uid': os.getuid(), 'gid': os.getgid(), 'cwd': os.getcwd(), 'hostname': socket.gethostname()}
if MODE == 'baseline':
    pathlib.Path('live-uncommitted.txt').write_text(MARKER)
    pathlib.Path('baseline.json').write_text(json.dumps(identity))
    emit({'defaultSelectedPlaceholder': os.environ.get(SELECTED) == placeholder(SELECTED),
          'defaultOtherPlaceholder': os.environ.get(OTHER) == placeholder(OTHER)})
elif MODE == 'injected':
    baseline = json.loads(pathlib.Path('baseline.json').read_text())
    emit({'selectedInjected': hashlib.sha256(os.environ.get(SELECTED, '').encode()).hexdigest() == EXPECTED_HASH,
          'otherPlaceholder': os.environ.get(OTHER) == placeholder(OTHER),
          'sameUid': identity['uid'] == baseline['uid'], 'sameGid': identity['gid'] == baseline['gid'],
          'explicitCwd': identity['cwd'] == baseline['cwd'], 'sameContainer': identity['hostname'] == baseline['hostname'],
          'liveUncommittedFile': pathlib.Path('live-uncommitted.txt').read_text() == MARKER,
          'explicitNonsecretEnv': os.environ.get('SECRET_EXEC_SMOKE_CONTEXT') == MARKER})
elif MODE == 'after':
    emit({'defaultSelectedStillPlaceholder': os.environ.get(SELECTED) == placeholder(SELECTED),
          'defaultOtherStillPlaceholder': os.environ.get(OTHER) == placeholder(OTHER)})
elif MODE == 'redaction':
    # Intentional echo of ONLY this fixture's selected synthetic sentinel.
    # Never use a real project credential for this mode.
    value = os.environ.get(SELECTED, '')
    assert hashlib.sha256(value.encode()).hexdigest() == EXPECTED_HASH
    print(value)
    print(value, file=sys.stderr)
else:
    raise SystemExit('Unsupported probe mode')
