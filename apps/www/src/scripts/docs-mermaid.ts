// Starlight injects this script on every docs page, so Mermaid itself is loaded only
// on a page that has a diagram.
export {};

// Starlight renders code blocks as: <figure class="frame"><pre data-language="mermaid"><code>...</code></pre></figure>
// wrapped in <div class="expressive-code">
const blocks = document.querySelectorAll<HTMLPreElement>('pre[data-language="mermaid"]');

if (blocks.length > 0) {
  const { default: mermaid } = await import('mermaid');
  mermaid.initialize({
    startOnLoad: false,
    theme: 'dark',
    // Mermaid 12 otherwise draws most diagrams in the `neo` look and lays them out
    // with ELK, a multi-megabyte chunk. Keep the classic dagre rendering.
    look: 'classic',
    layout: 'dagre',
  });

  for (const [index, pre] of Array.from(blocks).entries()) {
    // Starlight's expressive-code renders each line as a <div class="ec-line">.
    // textContent collapses them without newlines, which breaks Mermaid parsing.
    const lines = pre.querySelectorAll('.ec-line');
    const source =
      lines.length > 0
        ? Array.from(lines)
            .map((l) => l.textContent ?? '')
            .join('\n')
            .trim()
        : pre.textContent?.trim();
    if (!source) continue;

    // Replace the entire expressive-code wrapper (or just the pre if no wrapper)
    const wrapper = pre.closest('.expressive-code') ?? pre.closest('figure') ?? pre;

    const container = document.createElement('div');
    container.className = 'mermaid';
    wrapper.replaceWith(container);

    try {
      const { svg } = await mermaid.render(`docs-diagram-${index}`, source);
      container.innerHTML = svg;
    } catch {
      // Show the source as text: it is diagram syntax, not markup.
      const fallback = document.createElement('pre');
      fallback.style.color = '#ffd1d1';
      fallback.textContent = source;
      container.replaceChildren(fallback);
    }
  }
}
