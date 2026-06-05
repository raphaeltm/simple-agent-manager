import mermaid from 'mermaid';

mermaid.initialize({
  startOnLoad: false,
  theme: 'dark',
});

// Starlight renders code blocks as: <figure class="frame"><pre data-language="mermaid"><code>...</code></pre></figure>
// wrapped in <div class="expressive-code">
const blocks = document.querySelectorAll<HTMLPreElement>(
  'pre[data-language="mermaid"]'
);

if (blocks.length > 0) {
  for (const [index, pre] of Array.from(blocks).entries()) {
    // Starlight's expressive-code renders each line as a <div class="ec-line">.
    // textContent collapses them without newlines, which breaks Mermaid parsing.
    const lines = pre.querySelectorAll('.ec-line');
    const source = lines.length > 0
      ? Array.from(lines).map((l) => l.textContent ?? '').join('\n').trim()
      : pre.textContent?.trim();
    if (!source) continue;

    // Replace the entire expressive-code wrapper (or just the pre if no wrapper)
    const wrapper =
      pre.closest('.expressive-code') ?? pre.closest('figure') ?? pre;

    const container = document.createElement('div');
    container.className = 'mermaid';
    wrapper.replaceWith(container);

    try {
      const { svg } = await mermaid.render(`docs-diagram-${index}`, source);
      container.innerHTML = svg;
    } catch {
      container.innerHTML = `<pre style="color:#ffd1d1">${source}</pre>`;
    }
  }
}
