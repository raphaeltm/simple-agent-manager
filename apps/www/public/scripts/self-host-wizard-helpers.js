/* Helper functions for /scripts/self-host-wizard.js. Loaded on demand by the main wizard script. */
(function () {
  'use strict';

  function generateWebhookSecret() {
    var bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    var hex = '';
    for (var i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0');
    return hex;
  }

  function generatePassphrase() {
    var bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    var binary = '';
    for (var i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  }

  function base64Encode(str) {
    var bytes = new TextEncoder().encode(str);
    var binary = '';
    for (var i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  }

  function buildGitHubAppUrl(domain, appName, org) {
    var name = appName && appName.trim ? appName.trim() : appName || 'SAM';
    var apiUrl = 'https://api.' + domain;
    var params = new URLSearchParams();
    params.set('name', name || 'SAM');
    params.set('url', 'https://app.' + domain);
    params.append('callback_urls[]', apiUrl + '/api/auth/callback/github');
    params.set('setup_url', apiUrl + '/api/github/callback');
    params.set('setup_on_update', 'true');
    params.set('public', 'false');
    params.set('webhook_active', 'true');
    params.set('webhook_url', apiUrl + '/api/github/webhook');
    params.set('contents', 'write');
    params.set('metadata', 'read');
    params.set('email_addresses', 'read');
    params.set('issues', 'read');
    params.set('pull_requests', 'read');
    params.set('checks', 'read');
    params.set('actions', 'read');
    [
      'check_run',
      'check_suite',
      'issues',
      'issue_comment',
      'pull_request_review',
      'pull_request_review_comment',
      'repository',
      'workflow_run',
      'push',
      'pull_request',
    ].forEach(function (event) {
      params.append('events[]', event);
    });
    var base = org && org.trim ? org.trim() : org;
    var urlBase = base
      ? 'https://github.com/organizations/' + encodeURIComponent(base) + '/settings/apps/new'
      : 'https://github.com/settings/apps/new';
    return urlBase + '?' + params.toString();
  }

  function addPreviewRow(dl, term, value) {
    var dt = document.createElement('dt');
    dt.textContent = term;
    var dd = document.createElement('dd');
    dd.textContent = value;
    dl.appendChild(dt);
    dl.appendChild(dd);
  }

  function maskValue() {
    return '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022';
  }

  function missingStepFor(key) {
    if (key.indexOf('CF_') === 0) return 3;
    if (key.indexOf('GH_') === 0) return 4;
    if (key.indexOf('R2_') === 0) return 3;
    if (key === 'PULUMI_CONFIG_PASSPHRASE') return 5;
    return 6;
  }

  var SVG_NS = 'http://www.w3.org/2000/svg';
  var SVG_ATTRS = {
    width: '15',
    height: '15',
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '2',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
  };

  function createSvg(children) {
    var svg = document.createElementNS(SVG_NS, 'svg');
    Object.keys(SVG_ATTRS).forEach(function (k) {
      svg.setAttribute(k, SVG_ATTRS[k]);
    });
    children.forEach(function (child) {
      svg.appendChild(child);
    });
    return svg;
  }

  function svgEl(tag, attrs) {
    var el = document.createElementNS(SVG_NS, tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        el.setAttribute(k, attrs[k]);
      });
    }
    return el;
  }

  function copyIconEl() {
    return createSvg([
      svgEl('rect', { x: '9', y: '9', width: '13', height: '13', rx: '2', ry: '2' }),
      svgEl('path', { d: 'M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1' }),
    ]);
  }

  function eyeIconEl() {
    return createSvg([
      svgEl('path', { d: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z' }),
      svgEl('circle', { cx: '12', cy: '12', r: '3' }),
    ]);
  }

  function eyeOffIconEl() {
    return createSvg([
      svgEl('path', { d: 'M9.88 9.88a3 3 0 1 0 4.24 4.24' }),
      svgEl('path', {
        d: 'M10.73 5.08A10.43 10.43 0 0 1 12 5c6.5 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68',
      }),
      svgEl('path', {
        d: 'M6.61 6.61A13.526 13.526 0 0 0 2 12s3.5 7 10 7a9.74 9.74 0 0 0 5.39-1.61',
      }),
      svgEl('line', { x1: '2', x2: '22', y1: '2', y2: '22' }),
    ]);
  }

  function setIcon(el, iconFn) {
    var existing = el.querySelector('svg');
    if (existing) existing.remove();
    el.appendChild(iconFn());
  }

  function copyText(text, btn) {
    if (!text) return;
    var done = function () {
      if (!btn) return;
      btn.classList.add('is-copied');
      setTimeout(function () {
        btn.classList.remove('is-copied');
      }, 1400);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () {
        fallbackCopy(text, done);
      });
    } else {
      fallbackCopy(text, done);
    }
  }

  function fallbackCopy(text, done) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
    } catch (e) {
      /* noop */
    }
    document.body.removeChild(ta);
    done();
  }

  function renderRows(container, rows) {
    if (!container) return;
    container.replaceChildren();
    rows.forEach(function (row) {
      var hasValue = row.value && row.value.length > 0;
      var realVal = hasValue ? row.value : row.fallback || '';
      var displayVal = hasValue
        ? row.value
        : row.fallback
          ? row.fallback + ' (default)'
          : 'Add in Step ' + missingStepFor(row.key);
      var missing = !hasValue && !row.fallback;
      var maskable = !!row.secret && hasValue;
      var wrap = document.createElement('div');
      var key = document.createElement('button');
      var keyName = document.createElement('span');
      var val = document.createElement('span');
      var acts = document.createElement('span');
      var btn = document.createElement('button');

      wrap.className = 'sh-secret-row';
      key.type = 'button';
      key.className = 'sh-secret-key';
      key.title = 'Copy name';
      key.setAttribute('aria-label', 'Copy name ' + row.key);
      keyName.className = 'sh-secret-key-name';
      keyName.textContent = row.key;
      key.appendChild(keyName);
      if (row.note) {
        var keyNote = document.createElement('span');
        keyNote.className = 'sh-secret-key-note';
        keyNote.textContent = row.note;
        key.appendChild(keyNote);
      }
      key.addEventListener('click', function () {
        copyText(row.key, key);
      });

      val.className =
        'sh-secret-val' + (missing ? ' is-missing' : '') + (maskable ? ' is-masked' : '');
      val.textContent = maskable ? maskValue(realVal) : displayVal;
      acts.className = 'sh-secret-acts';
      if (maskable) addRevealButton(acts, val, realVal, row.key);
      btn.type = 'button';
      btn.className = 'sh-secret-act';
      btn.setAttribute('aria-label', 'Copy ' + row.key);
      btn.appendChild(copyIconEl());
      if (missing) btn.disabled = true;
      else
        btn.addEventListener('click', function () {
          copyText(realVal, btn);
        });
      acts.appendChild(btn);
      wrap.appendChild(key);
      wrap.appendChild(val);
      wrap.appendChild(acts);
      container.appendChild(wrap);
    });
  }

  function addRevealButton(acts, val, realVal, key) {
    var revealed = false;
    var eye = document.createElement('button');
    eye.type = 'button';
    eye.className = 'sh-secret-act sh-secret-reveal';
    eye.setAttribute('aria-label', 'Reveal ' + key);
    eye.setAttribute('aria-pressed', 'false');
    setIcon(eye, eyeIconEl);
    eye.addEventListener('click', function () {
      revealed = !revealed;
      val.textContent = revealed ? realVal : maskValue(realVal);
      val.classList.toggle('is-masked', !revealed);
      setIcon(eye, revealed ? eyeOffIconEl : eyeIconEl);
      eye.setAttribute('aria-pressed', revealed ? 'true' : 'false');
      eye.setAttribute('aria-label', (revealed ? 'Hide ' : 'Reveal ') + key);
    });
    acts.appendChild(eye);
  }

  function safeHttpsUrl(parts) {
    var url = parts.join('');
    try {
      var parsed = new URL(url);
      return parsed.protocol === 'https:' ? parsed.href : null;
    } catch (e) {
      return null;
    }
  }

  function shellQuote(value) {
    return "'" + String(value).replace(/'/g, "'\\''") + "'";
  }

  function buildGhScript(data, repo) {
    var lines = [];
    var r = repo ? ' --repo ' + shellQuote(repo) : '';
    data.vars.forEach(function (row) {
      var v = row.value && row.value.length > 0 ? row.value : row.fallback || '';
      if (v)
        lines.push('gh variable set ' + row.key + r + ' --env production --body ' + shellQuote(v));
    });
    data.secrets.forEach(function (row) {
      if (row.value && row.value.length > 0) {
        lines.push(
          'gh secret set ' + row.key + r + ' --env production --body ' + shellQuote(row.value)
        );
      }
    });
    return lines.join('\n');
  }

  function renderMaskedGhScript(script) {
    return script
      .split('\n')
      .map(function (line) {
        return line.replace(/(--body )('.*')$/, function (_match, prefix) {
          return prefix + maskValue();
        });
      })
      .join('\n');
  }

  function flash(el) {
    if (!el) return;
    el.focus();
    el.style.boxShadow = '0 0 0 3px rgba(245, 158, 11, 0.4)';
    setTimeout(function () {
      el.style.boxShadow = '';
    }, 1200);
  }

  window.SAMSelfHostWizardHelpers = {
    addPreviewRow: addPreviewRow,
    base64Encode: base64Encode,
    buildGhScript: buildGhScript,
    buildGitHubAppUrl: buildGitHubAppUrl,
    copyIconEl: copyIconEl,
    copyText: copyText,
    eyeIconEl: eyeIconEl,
    eyeOffIconEl: eyeOffIconEl,
    flash: flash,
    generatePassphrase: generatePassphrase,
    generateWebhookSecret: generateWebhookSecret,
    maskValue: maskValue,
    renderMaskedGhScript: renderMaskedGhScript,
    renderRows: renderRows,
    safeHttpsUrl: safeHttpsUrl,
    setIcon: setIcon,
  };
})();
