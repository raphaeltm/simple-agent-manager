/* SAM self-host guided setup wizard.
 * Pure client-side. No network calls. Secrets entered here never leave the tab.
 * Source of truth for steps/values: apps/www/src/content/docs/docs/guides/self-hosting.mdx
 */
(function () {
  'use strict';

  var main = document.querySelector('.sh');
  if (!main) return;

  var STORAGE_KEY = 'sam-self-host-wizard-v1';
  var STEP_IDS = [
    'welcome',
    'domain',
    'fork',
    'cf-token',
    'github-app',
    'passphrase',
    'github-env',
    'deploy',
  ];
  var LAST = STEP_IDS.length - 1;

  // --- DOM refs ---
  var panels = {};
  STEP_IDS.forEach(function (id) {
    panels[id] = main.querySelector('[data-panel="' + id + '"]');
  });
  var stepItems = Array.prototype.slice.call(main.querySelectorAll('[data-step-nav]'));
  var progressLabel = document.getElementById('sh-progress-label');
  var progressFill = document.getElementById('sh-progressbar-fill');
  var backBtn = document.getElementById('sh-back');
  var nextBtn = document.getElementById('sh-next');
  var nextLabel = document.getElementById('sh-next-label');
  var resetBtn = document.getElementById('sh-reset');

  // Non-secret fields persisted to localStorage.
  var FIELD_IDS = [
    'sh-domain',
    'sh-app-name',
    'sh-org',
    'sh-cf-account',
    'sh-cf-zone',
    'sh-app-id',
    'sh-client-id',
    'sh-app-slug',
    'sh-r2-key',
    'sh-repo',
  ];

  // --- State ---
  var state = {
    step: 0,
    furthest: 0,
    accountType: 'personal',
    webhookSecret: '',
    passphrase: '',
    fields: {},
  };

  function loadState() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      var saved = JSON.parse(raw);
      if (typeof saved.step === 'number') state.step = clampStep(saved.step);
      if (typeof saved.furthest === 'number') state.furthest = clampStep(saved.furthest);
      if (saved.accountType === 'org' || saved.accountType === 'personal') {
        state.accountType = saved.accountType;
      }
      if (typeof saved.webhookSecret === 'string') state.webhookSecret = saved.webhookSecret;
      if (typeof saved.passphrase === 'string') state.passphrase = saved.passphrase;
      if (saved.fields && typeof saved.fields === 'object') state.fields = saved.fields;
    } catch (e) {
      /* ignore corrupt state */
    }
  }

  function saveState() {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          step: state.step,
          furthest: state.furthest,
          accountType: state.accountType,
          webhookSecret: state.webhookSecret,
          passphrase: state.passphrase,
          fields: state.fields,
        })
      );
    } catch (e) {
      /* storage may be unavailable; wizard still works in-memory */
    }
  }

  function clampStep(n) {
    if (n < 0) return 0;
    if (n > LAST) return LAST;
    return n;
  }

  // --- Crypto helpers (mirror GitHubAppSetup.astro) ---
  function generateWebhookSecret() {
    var bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    var hex = '';
    for (var i = 0; i < bytes.length; i++) {
      hex += bytes[i].toString(16).padStart(2, '0');
    }
    return hex;
  }

  function generatePassphrase() {
    var bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    var binary = '';
    for (var i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  function base64Encode(str) {
    var bytes = new TextEncoder().encode(str);
    var binary = '';
    for (var i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  // --- Field helpers ---
  function fieldEl(id) {
    return document.getElementById(id);
  }

  function getField(id) {
    var el = fieldEl(id);
    return el ? el.value.trim() : '';
  }

  function restoreFields() {
    FIELD_IDS.forEach(function (id) {
      var el = fieldEl(id);
      if (el && typeof state.fields[id] === 'string') {
        el.value = state.fields[id];
      }
    });
  }

  function persistField(id) {
    var el = fieldEl(id);
    if (!el) return;
    state.fields[id] = el.value;
    saveState();
  }

  // --- Domain logic ---
  var DOMAIN_RE = /^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(\.[a-z0-9-]{1,63})+$/i;
  var ACCOUNT_ID_RE = /^[a-f0-9]{32}$/i;
  var derivedPrefixCache = { domain: '', prefix: '' };

  function getDomain() {
    return getField('sh-domain').toLowerCase();
  }

  function getCloudflareAccountId() {
    return getField('sh-cf-account');
  }

  function isValidDomain(d) {
    return DOMAIN_RE.test(d);
  }

  function isValidCloudflareAccountId(account) {
    return ACCOUNT_ID_RE.test(account);
  }

  function deriveResourcePrefix(domain) {
    domain = (domain || '').trim().toLowerCase();
    if (!domain) return Promise.resolve('');
    if (derivedPrefixCache.domain === domain) {
      return Promise.resolve(derivedPrefixCache.prefix);
    }
    if (!window.crypto || !window.crypto.subtle || !window.TextEncoder) {
      return Promise.reject(new Error('Web Crypto SHA-256 is unavailable in this browser.'));
    }
    return window.crypto.subtle
      .digest('SHA-256', new TextEncoder().encode(domain))
      .then(function (buffer) {
        var bytes = Array.prototype.slice.call(new Uint8Array(buffer));
        var hex = bytes
          .map(function (byte) {
            return byte.toString(16).padStart(2, '0');
          })
          .join('');
        var prefix = 's' + hex.slice(0, 6);
        derivedPrefixCache = { domain: domain, prefix: prefix };
        return prefix;
      });
  }

  function updateDomainDerived() {
    var d = getDomain();
    var err = document.getElementById('sh-domain-error');
    var derived = document.getElementById('sh-domain-derived');
    var valid = isValidDomain(d);

    if (err) err.hidden = d === '' || valid;

    if (derived) {
      if (valid) {
        derived.hidden = false;
        setDerived('app', 'https://app.' + d);
        setDerived('api', 'https://api.' + d);
        setDerived('ws', 'https://ws-<id>.' + d);
        setDerived('prefix', 'Generating...');
        deriveResourcePrefix(d)
          .then(function (prefix) {
            if (getDomain() === d) setDerived('prefix', prefix);
          })
          .catch(function () {
            if (getDomain() === d) setDerived('prefix', 'Unavailable');
          });
      } else {
        derived.hidden = true;
      }
    }
  }

  function updateCloudflareAccountValidation() {
    var account = getCloudflareAccountId();
    var err = document.getElementById('sh-cf-account-error');
    if (err) err.hidden = account === '' || isValidCloudflareAccountId(account);
  }

  function validateDomainStep() {
    var domainValid = isValidDomain(getDomain());
    var accountValid = isValidCloudflareAccountId(getCloudflareAccountId());
    updateDomainDerived();
    updateCloudflareAccountValidation();

    if (!domainValid) {
      var domainErr = document.getElementById('sh-domain-error');
      if (domainErr) domainErr.hidden = false;
      flash(fieldEl('sh-domain'));
      return false;
    }
    if (!accountValid) {
      var accountErr = document.getElementById('sh-cf-account-error');
      if (accountErr) accountErr.hidden = false;
      flash(fieldEl('sh-cf-account'));
      return false;
    }
    return true;
  }

  function setDerived(key, value) {
    var el = main.querySelector('[data-derived="' + key + '"]');
    if (el) el.textContent = value;
  }

  // --- GitHub App URL (mirror GitHubAppSetup.astro buildGitHubAppUrl) ---
  function buildGitHubAppUrl(domain, appName, org) {
    var name = appName && appName.trim() ? appName.trim() : 'SAM';
    var params = new URLSearchParams();
    params.set('name', name);
    params.set('url', 'https://app.' + domain);
    params.append('callback_urls[]', 'https://api.' + domain + '/api/auth/callback/github');
    params.set('setup_url', 'https://api.' + domain + '/api/github/callback');
    params.set('setup_on_update', 'true');
    params.set('public', 'false');
    params.set('webhook_active', 'true');
    params.set('webhook_url', 'https://api.' + domain + '/api/github/webhook');
    params.set('contents', 'write');
    params.set('metadata', 'read');
    params.set('email_addresses', 'read');
    params.set('pull_requests', 'read');
    params.append('events[]', 'push');
    params.append('events[]', 'pull_request');

    var base =
      org && org.trim()
        ? 'https://github.com/organizations/' +
          encodeURIComponent(org.trim()) +
          '/settings/apps/new'
        : 'https://github.com/settings/apps/new';
    return base + '?' + params.toString();
  }

  function generateAppLink() {
    var domain = getDomain();
    if (!isValidDomain(domain)) {
      goTo(STEP_IDS.indexOf('domain'));
      flash(fieldEl('sh-domain'));
      return;
    }
    if (!state.webhookSecret) {
      state.webhookSecret = generateWebhookSecret();
      saveState();
    }
    var appName = getField('sh-app-name') || 'SAM';
    var org = state.accountType === 'org' ? getField('sh-org') : '';
    var url = buildGitHubAppUrl(domain, appName, org);

    var link = document.getElementById('sh-app-link');
    if (link) link.href = url;

    var secretEl = document.getElementById('sh-webhook-secret');
    if (secretEl) secretEl.textContent = state.webhookSecret;

    var preview = document.getElementById('sh-app-preview');
    if (preview) {
      preview.innerHTML = '';
      addPreviewRow(preview, 'Name', appName);
      addPreviewRow(preview, 'Homepage URL', 'https://app.' + domain);
      addPreviewRow(preview, 'Callback URL', 'https://api.' + domain + '/api/auth/callback/github');
      addPreviewRow(preview, 'Setup URL', 'https://api.' + domain + '/api/github/callback');
      addPreviewRow(preview, 'Redirect on update', 'Enabled');
      addPreviewRow(preview, 'Webhook URL', 'https://api.' + domain + '/api/github/webhook');
      addPreviewRow(
        preview,
        'Permissions',
        'Contents: write · Metadata: read · Emails: read · Pull requests: read'
      );
      addPreviewRow(preview, 'Events', 'push, pull_request');
    }

    var result = document.getElementById('sh-app-result');
    if (result) result.hidden = false;
  }

  function addPreviewRow(dl, term, value) {
    var dt = document.createElement('dt');
    dt.textContent = term;
    var dd = document.createElement('dd');
    dd.textContent = value;
    dl.appendChild(dt);
    dl.appendChild(dd);
  }

  // --- Passphrase ---
  function ensurePassphrase() {
    if (!state.passphrase) {
      state.passphrase = generatePassphrase();
      saveState();
    }
    var el = document.getElementById('sh-passphrase');
    if (el) el.textContent = state.passphrase;
  }

  // --- Step 6: vars + secrets output ---
  // Single source of truth for the GitHub Environment vars/secrets, shared by
  // the row renderer and the gh CLI script generator.
  function getEnvData(resourcePrefix) {
    var domain = getDomain();

    var vars = [
      { key: 'BASE_DOMAIN', value: domain, required: true },
      { key: 'RESOURCE_PREFIX', value: resourcePrefix, required: true },
    ];

    var privateKey = getField('sh-private-key');
    var secrets = [
      { key: 'CF_API_TOKEN', value: getField('sh-cf-token'), secret: true },
      { key: 'CF_ACCOUNT_ID', value: getField('sh-cf-account') },
      { key: 'CF_ZONE_ID', value: getField('sh-cf-zone') },
      { key: 'R2_ACCESS_KEY_ID', value: getField('sh-r2-key') },
      { key: 'R2_SECRET_ACCESS_KEY', value: getField('sh-r2-secret'), secret: true },
      { key: 'PULUMI_CONFIG_PASSPHRASE', value: state.passphrase, secret: true },
      { key: 'GH_CLIENT_ID', value: getField('sh-client-id') },
      { key: 'GH_CLIENT_SECRET', value: getField('sh-client-secret'), secret: true },
      { key: 'GH_APP_ID', value: getField('sh-app-id') },
      {
        key: 'GH_APP_PRIVATE_KEY',
        value: privateKey ? base64Encode(privateKey) : '',
        secret: true,
        note: 'base64-encoded',
      },
      { key: 'GH_APP_SLUG', value: getField('sh-app-slug') },
      { key: 'GH_WEBHOOK_SECRET', value: state.webhookSecret, secret: true },
    ];

    return { vars: vars, secrets: secrets };
  }

  function renderEnvOutputs() {
    var domain = getDomain();
    var varsOutput = document.getElementById('sh-vars-output');
    var secretsOutput = document.getElementById('sh-secrets-output');
    var ghOut = document.getElementById('sh-gh-cli-output');
    if (varsOutput) varsOutput.textContent = 'Generating resource prefix...';
    if (secretsOutput) secretsOutput.textContent = '';
    if (ghOut) {
      ghOut.setAttribute('data-script', '');
      var code = ghOut.querySelector('code');
      if (code) code.textContent = '# Generating resource prefix...';
    }

    deriveResourcePrefix(domain)
      .then(function (resourcePrefix) {
        if (domain !== getDomain() || STEP_IDS[state.step] !== 'github-env') return;
        var data = getEnvData(resourcePrefix);
        renderRows(varsOutput, data.vars);
        renderRows(secretsOutput, data.secrets);
        renderGhCli(data);
      })
      .catch(function (err) {
        if (varsOutput) {
          varsOutput.textContent =
            err && err.message ? err.message : 'Could not generate RESOURCE_PREFIX.';
        }
      });
  }

  function maskValue(value) {
    // Show a fixed-length dot run rather than mirroring the real length, so the
    // mask never leaks how long the secret is.
    return '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022';
  }

  function renderRows(container, rows) {
    if (!container) return;
    container.innerHTML = '';
    rows.forEach(function (row) {
      var hasValue = row.value && row.value.length > 0;
      var realVal;
      var displayVal;
      var missing = false;
      if (hasValue) {
        realVal = row.value;
        displayVal = row.value;
      } else if (row.fallback) {
        realVal = row.fallback;
        displayVal = row.fallback + ' (default)';
      } else {
        realVal = '';
        displayVal = 'Add in Step ' + missingStepFor(row.key);
        missing = true;
      }

      // Secret rows with a real value start masked; everything else shows plainly.
      var maskable = !!row.secret && hasValue;

      var wrap = document.createElement('div');
      wrap.className = 'sh-secret-row';

      var key = document.createElement('button');
      key.type = 'button';
      key.className = 'sh-secret-key';
      key.title = 'Copy name';
      key.setAttribute('aria-label', 'Copy name ' + row.key);
      var keyName = document.createElement('span');
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

      var val = document.createElement('span');
      val.className =
        'sh-secret-val' + (missing ? ' is-missing' : '') + (maskable ? ' is-masked' : '');
      val.textContent = maskable ? maskValue(realVal) : displayVal;

      var acts = document.createElement('span');
      acts.className = 'sh-secret-acts';

      if (maskable) {
        var revealed = false;
        var eye = document.createElement('button');
        eye.type = 'button';
        eye.className = 'sh-secret-act sh-secret-reveal';
        eye.setAttribute('aria-label', 'Reveal ' + row.key);
        eye.setAttribute('aria-pressed', 'false');
        eye.innerHTML = eyeIcon();
        eye.addEventListener('click', function () {
          revealed = !revealed;
          val.textContent = revealed ? realVal : maskValue(realVal);
          val.classList.toggle('is-masked', !revealed);
          eye.innerHTML = revealed ? eyeOffIcon() : eyeIcon();
          eye.setAttribute('aria-pressed', revealed ? 'true' : 'false');
          eye.setAttribute('aria-label', (revealed ? 'Hide ' : 'Reveal ') + row.key);
        });
        acts.appendChild(eye);
      }

      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'sh-secret-act';
      btn.setAttribute('aria-label', 'Copy ' + row.key);
      btn.innerHTML = copyIcon();
      if (missing) {
        btn.disabled = true;
      } else {
        btn.addEventListener('click', function () {
          copyText(realVal, btn);
        });
      }
      acts.appendChild(btn);

      wrap.appendChild(key);
      wrap.appendChild(val);
      wrap.appendChild(acts);
      container.appendChild(wrap);
    });
  }

  function missingStepFor(key) {
    if (key.indexOf('CF_') === 0) return 3;
    if (key.indexOf('GH_') === 0) return 4;
    if (key.indexOf('R2_') === 0) return 3;
    if (key === 'PULUMI_CONFIG_PASSPHRASE') return 5;
    return 6;
  }

  function copyIcon() {
    return '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
  }

  function eyeIcon() {
    return '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>';
  }

  function eyeOffIcon() {
    return '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"/><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c6.5 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3.5 7 10 7a9.74 9.74 0 0 0 5.39-1.61"/><line x1="2" x2="22" y1="2" y2="22"/></svg>';
  }

  // --- Step 6: gh CLI one-shot script ---
  // Single-quote escaping for POSIX shells: close the quote, emit an escaped
  // quote, reopen — '\'' — so arbitrary values (incl. base64 PEM) survive intact.
  function shellQuote(value) {
    return "'" + String(value).replace(/'/g, "'\\''") + "'";
  }

  function buildGhScript(data, repo) {
    var lines = [];
    var r = repo ? ' --repo ' + shellQuote(repo) : '';
    data.vars.forEach(function (row) {
      var v = row.value && row.value.length > 0 ? row.value : row.fallback || '';
      if (!v) return;
      lines.push('gh variable set ' + row.key + r + ' --env production --body ' + shellQuote(v));
    });
    data.secrets.forEach(function (row) {
      if (!row.value || row.value.length === 0) return;
      lines.push(
        'gh secret set ' + row.key + r + ' --env production --body ' + shellQuote(row.value)
      );
    });
    return lines.join('\n');
  }

  function renderGhCli(data) {
    var repo = getField('sh-repo').trim();
    var out = document.getElementById('sh-gh-cli-output');
    if (!out) return;

    var script = buildGhScript(data, repo);
    // Cache the real script so the copy button copies the unmasked text even
    // while the on-screen lines are masked.
    out.setAttribute('data-script', script);

    var code = out.querySelector('code');
    if (code) {
      code.textContent =
        renderMaskedGhScript(script) || '# Fill in the earlier steps to generate the command.';
    }
    out.setAttribute('data-revealed', 'false');

    var note = document.getElementById('sh-gh-cli-repo-note');
    if (note) note.hidden = !!repo;
  }

  function renderMaskedGhScript(script) {
    return script
      .split('\n')
      .map(function (line) {
        return line.replace(/(--body )('.*')$/, function (m, p1) {
          return p1 + maskValue();
        });
      })
      .join('\n');
  }

  // --- Step 7: deploy ---
  function renderDeploy() {
    var domain = getDomain();
    var d = isValidDomain(domain) ? domain : 'yourdomain.com';
    var health = document.getElementById('sh-health-cmd');
    if (health) health.textContent = 'curl https://api.' + d + '/health';
    var open = document.getElementById('sh-app-open');
    if (open) {
      open.href = 'https://app.' + d;
      open.textContent = 'https://app.' + d;
    }
    var login = document.getElementById('sh-app-login');
    if (login) login.href = 'https://app.' + d;
  }

  function renderCloudflareLinks() {
    var account = getCloudflareAccountId();
    var domain = getDomain();
    var hasAccount = isValidCloudflareAccountId(account);
    var cfApiLink = document.getElementById('sh-cf-api-link');
    var zoneLink = document.getElementById('sh-cf-zone-link');

    if (cfApiLink) {
      cfApiLink.href = hasAccount
        ? 'https://dash.cloudflare.com/' + account + '/api-tokens'
        : 'https://dash.cloudflare.com/';
    }
    if (zoneLink) {
      zoneLink.href =
        hasAccount && isValidDomain(domain)
          ? 'https://dash.cloudflare.com/' + account + '/' + domain
          : 'https://dash.cloudflare.com/';
    }
  }

  // --- Copy helpers ---
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

  function flash(el) {
    if (!el) return;
    el.focus();
    el.style.boxShadow = '0 0 0 3px rgba(245, 158, 11, 0.4)';
    setTimeout(function () {
      el.style.boxShadow = '';
    }, 1200);
  }

  // --- Navigation / rendering ---
  function nextLabelFor(step) {
    if (step === 0) return 'Get started';
    return 'Continue';
  }

  function render() {
    STEP_IDS.forEach(function (id, i) {
      if (panels[id]) panels[id].hidden = i !== state.step;
    });

    stepItems.forEach(function (item) {
      var num = parseInt(item.getAttribute('data-num'), 10);
      var btn = item.querySelector('[data-goto]');
      var isActive = num === state.step;
      item.classList.toggle('is-current', isActive);
      // Done = visited and moved past (anything below the furthest point we reached, except the current step).
      item.classList.toggle('is-done', num !== state.step && num < state.furthest);
      if (btn) {
        btn.disabled = num > state.furthest;
        btn.setAttribute('aria-current', isActive ? 'step' : 'false');
      }
    });

    if (progressLabel) {
      progressLabel.hidden = state.step === 0;
      progressLabel.textContent = 'Step ' + state.step + ' of ' + LAST;
    }
    if (progressFill) progressFill.style.width = Math.round((state.step / LAST) * 100) + '%';

    if (backBtn) backBtn.hidden = state.step === 0;
    if (nextBtn) nextBtn.hidden = state.step === LAST;
    if (nextLabel) nextLabel.textContent = nextLabelFor(state.step);

    // Per-step side effects
    var id = STEP_IDS[state.step];
    if (id === 'domain') {
      updateDomainDerived();
      updateCloudflareAccountValidation();
    }
    if (id === 'cf-token') renderCloudflareLinks();
    if (id === 'github-app') {
      if (state.webhookSecret) generateAppLink();
    }
    if (id === 'passphrase') ensurePassphrase();
    if (id === 'github-env') renderEnvOutputs();
    if (id === 'deploy') renderDeploy();

    try {
      main.scrollIntoView({ block: 'start', behavior: 'auto' });
      window.scrollTo({ top: 0, behavior: 'auto' });
    } catch (e) {
      /* noop */
    }
  }

  function goTo(step) {
    state.step = clampStep(step);
    if (state.step > state.furthest) state.furthest = state.step;
    saveState();
    render();
    // Move focus to the new step's heading so screen-reader and keyboard users
    // get announced context on each transition (only on user navigation).
    var id = STEP_IDS[state.step];
    var heading = panels[id] && panels[id].querySelector('.sh-h1, .sh-h2');
    if (heading) {
      heading.setAttribute('tabindex', '-1');
      try {
        heading.focus();
      } catch (e) {
        /* noop */
      }
    }
  }

  function next() {
    if (state.step >= LAST) return;
    if (STEP_IDS[state.step] === 'domain' && !validateDomainStep()) {
      return;
    }
    goTo(state.step + 1);
  }

  function back() {
    if (state.step <= 0) return;
    goTo(state.step - 1);
  }

  // --- Wire up ---
  function init() {
    loadState();
    restoreFields();

    // Account type
    var accountRadios = Array.prototype.slice.call(
      main.querySelectorAll('input[name="sh-account-type"]')
    );
    accountRadios.forEach(function (r) {
      r.checked = r.value === state.accountType;
      r.addEventListener('change', function () {
        if (r.checked) {
          state.accountType = r.value;
          var orgField = document.getElementById('sh-org-field');
          if (orgField) orgField.hidden = r.value !== 'org';
          saveState();
        }
      });
    });
    var orgField = document.getElementById('sh-org-field');
    if (orgField) orgField.hidden = state.accountType !== 'org';

    // Persisted text fields
    FIELD_IDS.forEach(function (fid) {
      var el = fieldEl(fid);
      if (!el) return;
      el.addEventListener('input', function () {
        persistField(fid);
        if (fid === 'sh-domain') updateDomainDerived();
        if (fid === 'sh-cf-account') updateCloudflareAccountValidation();
        if (fid === 'sh-domain' || fid === 'sh-cf-account') renderCloudflareLinks();
        if (STEP_IDS[state.step] === 'github-env') renderEnvOutputs();
      });
    });

    // Secret fields (not persisted) still refresh dependent outputs live
    ['sh-cf-token', 'sh-client-secret', 'sh-private-key', 'sh-r2-secret'].forEach(function (sid) {
      var el = fieldEl(sid);
      if (el) {
        el.addEventListener('input', function () {
          if (STEP_IDS[state.step] === 'github-env') renderEnvOutputs();
        });
      }
    });

    // gh CLI command: reveal toggle + copy (copies the real, unmasked script)
    var ghReveal = document.getElementById('sh-gh-cli-reveal');
    var ghCopy = document.getElementById('sh-gh-cli-copy');
    var ghOut = document.getElementById('sh-gh-cli-output');
    if (ghReveal) ghReveal.innerHTML = eyeIcon();
    if (ghCopy) ghCopy.innerHTML = copyIcon();
    if (ghReveal && ghOut) {
      ghReveal.addEventListener('click', function () {
        var revealed = ghOut.getAttribute('data-revealed') === 'true';
        revealed = !revealed;
        ghOut.setAttribute('data-revealed', revealed ? 'true' : 'false');
        var script = ghOut.getAttribute('data-script') || '';
        var code = ghOut.querySelector('code');
        if (code) {
          if (revealed) {
            code.textContent = script || '# Fill in the earlier steps to generate the command.';
          } else {
            code.textContent =
              renderMaskedGhScript(script) ||
              '# Fill in the earlier steps to generate the command.';
          }
        }
        ghReveal.innerHTML = revealed ? eyeOffIcon() : eyeIcon();
        ghReveal.setAttribute('aria-pressed', revealed ? 'true' : 'false');
        ghReveal.setAttribute('aria-label', (revealed ? 'Hide' : 'Reveal') + ' command values');
      });
    }
    if (ghCopy && ghOut) {
      ghCopy.addEventListener('click', function () {
        copyText(ghOut.getAttribute('data-script') || '', ghCopy);
      });
    }

    // Buttons
    if (nextBtn) nextBtn.addEventListener('click', next);
    if (backBtn) backBtn.addEventListener('click', back);

    stepItems.forEach(function (item) {
      var btn = item.querySelector('[data-goto]');
      if (!btn) return;
      btn.addEventListener('click', function () {
        var num = parseInt(item.getAttribute('data-num'), 10);
        if (num <= state.furthest) goTo(num);
      });
    });

    var appGen = document.getElementById('sh-app-generate');
    if (appGen) appGen.addEventListener('click', generateAppLink);

    var regen = document.getElementById('sh-passphrase-regen');
    if (regen) {
      regen.addEventListener('click', function () {
        state.passphrase = generatePassphrase();
        saveState();
        ensurePassphrase();
      });
    }

    // Generic copy buttons (data-copy-target)
    Array.prototype.slice.call(main.querySelectorAll('[data-copy-target]')).forEach(function (btn) {
      btn.addEventListener('click', function () {
        var target = document.getElementById(btn.getAttribute('data-copy-target'));
        if (target) copyText(target.textContent, btn);
      });
    });

    if (resetBtn) {
      resetBtn.addEventListener('click', function () {
        if (!confirm('Reset all progress and clear the values you entered on this page?')) return;
        try {
          localStorage.removeItem(STORAGE_KEY);
        } catch (e) {
          /* noop */
        }
        state = {
          step: 0,
          furthest: 0,
          accountType: 'personal',
          webhookSecret: '',
          passphrase: '',
          fields: {},
        };
        FIELD_IDS.forEach(function (fid) {
          var el = fieldEl(fid);
          if (el) el.value = '';
        });
        ['sh-cf-token', 'sh-client-secret', 'sh-private-key', 'sh-r2-secret'].forEach(
          function (sid) {
            var el = fieldEl(sid);
            if (el) el.value = '';
          }
        );
        var result = document.getElementById('sh-app-result');
        if (result) result.hidden = true;
        accountRadios.forEach(function (r) {
          r.checked = r.value === 'personal';
        });
        if (orgField) orgField.hidden = true;
        render();
      });
    }

    render();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
