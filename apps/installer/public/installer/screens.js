import { $, state } from './state.js';
import { renderStatus } from './status.js';

const SCREENS = ['connect', 'choose', 'review', 'ready'];
const STEP_IDS = ['step-connect', 'step-choose', 'step-review', 'step-handoff'];
// The step order is fixed across both installer modes so the indicator never
// changes length between screens. Bootstrap mode has no plan to review, so
// its Review step is greyed out ("skipped") instead of being removed.
const STEP_INDEX = { connect: 0, choose: 1, review: 2, ready: 3 };

export function stepIndex(name) {
  return STEP_INDEX[name];
}

export function screen(name) {
  for (const id of SCREENS) $(id).hidden = id !== name;
  // Only Connect keeps the full marketing hero, mode note and trust section.
  // Every later step shows a slim header so the step card is the whole story.
  const onConnect = name === 'connect';
  $('hero-copy').hidden = !onConnect;
  $('slim-header').hidden = onConnect;
  $('mode-note').hidden = !onConnect;
  $('trust').hidden = !onConnect;
}

export function progress(current) {
  STEP_IDS.forEach((id, index) => {
    const li = $(id);
    li.removeAttribute('aria-current');
    const skipped = !state.fullInstaller && id === 'step-review';
    li.classList.toggle('skipped', skipped);
    li.classList.toggle('completed', !skipped && index < current);
    li.querySelector('.step-number').textContent = skipped
      ? '–'
      : index < current
        ? '✓'
        : String(index + 1);
  });
  $(STEP_IDS[current]).setAttribute('aria-current', 'step');
}

export function message(text, tone = 'notice') {
  renderStatus($('message'), text, tone);
}

export function returnToConnect(text) {
  $('confirm').checked = false;
  $('confirm-full').checked = false;
  $('install-simple').disabled = true;
  $('install').disabled = true;
  screen('connect');
  $('disconnect').hidden = true;
  progress(0);
  message(text);
}
