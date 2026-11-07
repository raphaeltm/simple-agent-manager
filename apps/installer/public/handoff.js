// Generate and save recovery before the cross-origin claim request. A lost response
// must not leave the owner without the credential already committed by the service.
const form = document.getElementById('maintenance-claim-form');
const recovery = document.getElementById('maintenance-recovery');
const display = document.getElementById('maintenance-recovery-display');
const copy = document.getElementById('maintenance-recovery-copy');
const saved = document.getElementById('maintenance-recovery-saved');
const submit = document.getElementById('maintenance-claim-submit');
const status = document.getElementById('maintenance-handoff-status');
if (form && recovery && display && saved && submit) {
  submit.disabled = true;
  saved.checked = false;
  try {
    const value = [...crypto.getRandomValues(new Uint8Array(32))]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
    recovery.value = value;
    display.value = value;
    display.readOnly = true;
    display.autocomplete = 'off';
    display.spellcheck = false;
    if (copy)
      copy.addEventListener('click', async () => {
        const original = copy.textContent;
        try {
          await navigator.clipboard.writeText(value);
          copy.textContent = 'Copied';
        } catch {
          display.select();
          copy.textContent = 'Select the credential above and copy it manually';
        }
        setTimeout(() => {
          copy.textContent = original;
        }, 2000);
      });
    saved.addEventListener('change', () => {
      submit.disabled = !saved.checked;
    });
    form.addEventListener('submit', (event) => {
      if (!saved.checked || !/^[a-f0-9]{64}$/.test(recovery.value)) event.preventDefault();
    });
    if (status)
      status.textContent =
        'Save this credential in your password manager, then confirm below. It is sent only to your installation service when you continue.';
  } catch {
    recovery.value = '';
    display.value = '';
    if (status)
      status.textContent =
        'This browser could not generate a secure recovery credential. Keep this page open and try a supported browser.';
  }
}
