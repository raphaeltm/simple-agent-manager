/* SAM self-host guided setup wizard.
 * Pure client-side. No network calls. Secrets entered or generated here never leave the tab.
 * Source of truth for steps/values: apps/www/src/content/docs/docs/guides/self-hosting.mdx
 */
(function () {
  'use strict';

  if (window.SAMSelfHostWizardStarted) return;
  var helpers = window.SAMSelfHostWizardHelpers;
  if (!helpers) {
    var helperScript = document.createElement('script');
    helperScript.src = '/scripts/self-host-wizard-helpers.js';
    helperScript.onload = function () {
      var mainScript = document.createElement('script');
      mainScript.src = '/scripts/self-host-wizard.js';
      document.head.appendChild(mainScript);
    };
    document.head.appendChild(helperScript);
    return;
  }
  window.SAMSelfHostWizardStarted = true;

  var generateWebhookSecret = helpers.generateWebhookSecret;
  var generatePassphrase = helpers.generatePassphrase;
  var base64Encode = helpers.base64Encode;
  var buildGitHubAppUrl = helpers.buildGitHubAppUrl;
  var addPreviewRow = helpers.addPreviewRow;
  var renderRows = helpers.renderRows;
  var copyIconEl = helpers.copyIconEl;
  var eyeIconEl = helpers.eyeIconEl;
  var eyeOffIconEl = helpers.eyeOffIconEl;
  var setIcon = helpers.setIcon;
  var safeHttpsUrl = helpers.safeHttpsUrl;
  var buildGhScript = helpers.buildGhScript;
  var renderMaskedGhScript = helpers.renderMaskedGhScript;
  var copyText = helpers.copyText;
  var flash = helpers.flash;

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
      var hasLegacyPersistedSecrets =
        Object.prototype.hasOwnProperty.call(saved, 'webhookSecret') ||
        Object.prototype.hasOwnProperty.call(saved, 'passphrase');
      if (typeof saved.step === 'number') state.step = clampStep(saved.step);
      if (typeof saved.furthest === 'number') state.furthest = clampStep(saved.furthest);
      if (saved.accountType === 'org' || saved.accountType === 'personal') {
        state.accountType = saved.accountType;
      }
      if (saved.fields && typeof saved.fields === 'object') state.fields = saved.fields;
      if (hasLegacyPersistedSecrets) saveState();
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

  // --- Passphrase ---
  function ensurePassphrase() {
    if (!state.passphrase) {
      state.passphrase = generatePassphrase();
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
      ghCliScriptCache = '';
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

  // --- Step 6: gh CLI one-shot script ---
  // Closure variable for the unmasked gh CLI script. Avoids exposing secrets in
  // the DOM (previously stored as a data-script attribute).
  var ghCliScriptCache = '';

  function renderGhCli(data) {
    var repo = getField('sh-repo').trim();
    var out = document.getElementById('sh-gh-cli-output');
    if (!out) return;

    var script = buildGhScript(data, repo);
    ghCliScriptCache = script;

    var code = out.querySelector('code');
    if (code) {
      code.textContent =
        renderMaskedGhScript(script) || '# Fill in the earlier steps to generate the command.';
    }
    out.setAttribute('data-revealed', 'false');

    var note = document.getElementById('sh-gh-cli-repo-note');
    if (note) note.hidden = !!repo;
  }

  // --- Step 7: deploy ---
  function renderDeploy() {
    var domain = getDomain();
    var d = isValidDomain(domain) ? domain : 'yourdomain.com';
    var appUrl = safeHttpsUrl(['https://app.', d]) || 'https://app.yourdomain.com';
    var apiUrl =
      safeHttpsUrl(['https://api.', d, '/health']) || 'https://api.yourdomain.com/health';
    var health = document.getElementById('sh-health-cmd');
    if (health) health.textContent = 'curl ' + apiUrl;
    var open = document.getElementById('sh-app-open');
    if (open) {
      open.href = appUrl;
      open.textContent = appUrl.replace(/\/$/, '');
    }
    var login = document.getElementById('sh-app-login');
    if (login) login.href = appUrl;
  }

  function renderCloudflareLinks() {
    var account = getCloudflareAccountId();
    var domain = getDomain();
    var hasAccount = isValidCloudflareAccountId(account);
    var fallback = 'https://dash.cloudflare.com/';
    var cfApiLink = document.getElementById('sh-cf-api-link');
    var zoneLink = document.getElementById('sh-cf-zone-link');

    if (cfApiLink) {
      cfApiLink.href =
        (hasAccount &&
          safeHttpsUrl([
            'https://dash.cloudflare.com/',
            encodeURIComponent(account),
            '/api-tokens',
          ])) ||
        fallback;
    }
    if (zoneLink) {
      zoneLink.href =
        (hasAccount &&
          isValidDomain(domain) &&
          safeHttpsUrl([
            'https://dash.cloudflare.com/',
            encodeURIComponent(account),
            '/',
            encodeURIComponent(domain),
          ])) ||
        fallback;
    }
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
    if (ghReveal) setIcon(ghReveal, eyeIconEl);
    if (ghCopy) setIcon(ghCopy, copyIconEl);
    if (ghReveal && ghOut) {
      ghReveal.addEventListener('click', function () {
        var revealed = ghOut.getAttribute('data-revealed') === 'true';
        revealed = !revealed;
        ghOut.setAttribute('data-revealed', revealed ? 'true' : 'false');
        var code = ghOut.querySelector('code');
        if (code) {
          if (revealed) {
            code.textContent =
              ghCliScriptCache || '# Fill in the earlier steps to generate the command.';
          } else {
            code.textContent =
              renderMaskedGhScript(ghCliScriptCache) ||
              '# Fill in the earlier steps to generate the command.';
          }
        }
        setIcon(ghReveal, revealed ? eyeOffIconEl : eyeIconEl);
        ghReveal.setAttribute('aria-pressed', revealed ? 'true' : 'false');
        ghReveal.setAttribute('aria-label', (revealed ? 'Hide' : 'Reveal') + ' command values');
      });
    }
    if (ghCopy && ghOut) {
      ghCopy.addEventListener('click', function () {
        copyText(ghCliScriptCache || '', ghCopy);
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
        ['sh-webhook-secret', 'sh-passphrase'].forEach(function (id) {
          var el = document.getElementById(id);
          if (el) el.textContent = '';
        });
        ghCliScriptCache = '';
        var ghOut = document.getElementById('sh-gh-cli-output');
        if (ghOut) {
          ghOut.setAttribute('data-revealed', 'false');
          var code = ghOut.querySelector('code');
          if (code) code.textContent = '# Fill in the earlier steps to generate the command.';
        }
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
