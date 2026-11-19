interface ThemedFiles {
  dark: string;
  light: string;
}

interface Size {
  width: number;
  height: number;
}

/**
 * Inline custom properties holding both theme variants of a real-UI layer. Component styles turn
 * the active theme's variable into `background-image`, so a visitor only downloads what they see.
 */
export function themedImage(files: ThemedFiles, size?: Size): string {
  const style = [`--img-dark:url(${files.dark})`, `--img-light:url(${files.light})`];
  if (size) style.push(`aspect-ratio:${size.width} / ${size.height}`);
  return style.join(';');
}
