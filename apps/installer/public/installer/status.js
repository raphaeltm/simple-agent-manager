// Renders a plain-language-first status message. Server errors arrive as
// "<plain summary> Details: <technical>. No credentials were logged." — the
// summary stays visible with an icon for error/warning tones; the technical
// half moves behind a collapsed disclosure so raw provider codes never lead.
const DETAILS_MARKER = ' Details: ';

export function renderStatus(container, text, tone = 'notice') {
  container.dataset.tone = tone;
  container.replaceChildren();
  if (!text) return;
  const at = typeof text === 'string' ? text.indexOf(DETAILS_MARKER) : -1;
  const summaryText = at === -1 ? text : text.slice(0, at);
  const headline = document.createElement('p');
  headline.className = 'status-line';
  if (tone === 'error' || tone === 'warning') {
    const icon = document.createElement('span');
    icon.className = 'status-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = '⚠';
    headline.append(icon);
  }
  const summary = document.createElement('span');
  summary.textContent = summaryText;
  headline.append(summary);
  container.append(headline);
  if (at !== -1) {
    const details = document.createElement('details');
    const technical = document.createElement('summary');
    technical.textContent = 'Technical details';
    const body = document.createElement('p');
    body.className = 'small';
    body.textContent = text.slice(at + DETAILS_MARKER.length);
    details.append(technical, body);
    container.append(details);
  }
  return container;
}
