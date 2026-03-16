#!/usr/bin/env tsx
/**
 * OG Image Generator for SAM
 *
 * Usage:
 *   pnpm generate                                    # Generate default OG image
 *   pnpm generate --template default                 # Same as above
 *   pnpm generate --title "Blog Post" --subtitle "A subtitle"
 *   pnpm generate --output ../../apps/www/public/images/og.png
 *
 * Templates live in ./templates/ — add a new .ts file to create a new template.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import satori from 'satori';
import { Resvg } from '@resvg/resvg-js';
import type { TemplateModule } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function parseArgs(args: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith('--')) {
        result[key] = next;
        i++;
      } else {
        result[key] = 'true';
      }
    }
  }
  return result;
}

function loadFont(relativePath: string): Buffer {
  const fullPath = resolve(__dirname, relativePath);
  return readFileSync(fullPath);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const templateName = args.template ?? 'default';

  console.log(`Loading template: ${templateName}`);

  // Dynamic import of the template
  const templateModule: TemplateModule = await import(
    `./templates/${templateName}.js`
  );

  const { config, render } = templateModule;

  // Load icon as base64 data URI
  const iconPath = resolve(__dirname, '../../assets/images/bag.png');
  const iconBuffer = readFileSync(iconPath);
  const iconDataUri = `data:image/png;base64,${iconBuffer.toString('base64')}`;

  // Render the template
  const element = render({
    title: args.title,
    subtitle: args.subtitle,
    iconDataUri,
  });

  // Load fonts
  const chillaxBold = loadFont(
    '../../assets/fonts/chillax/fonts/Chillax-Bold.ttf'
  );
  const chillaxSemibold = loadFont(
    '../../assets/fonts/chillax/fonts/Chillax-Semibold.ttf'
  );
  const chillaxRegular = loadFont(
    '../../assets/fonts/chillax/fonts/Chillax-Regular.ttf'
  );
  const chillaxMedium = loadFont(
    '../../assets/fonts/chillax/fonts/Chillax-Medium.ttf'
  );

  console.log(`Rendering ${config.width}x${config.height} image...`);

  // Generate SVG via satori
  const svg = await satori(element as React.ReactNode, {
    width: config.width,
    height: config.height,
    fonts: [
      {
        name: 'Chillax',
        data: chillaxRegular,
        weight: 400,
        style: 'normal',
      },
      {
        name: 'Chillax',
        data: chillaxMedium,
        weight: 500,
        style: 'normal',
      },
      {
        name: 'Chillax',
        data: chillaxSemibold,
        weight: 600,
        style: 'normal',
      },
      {
        name: 'Chillax',
        data: chillaxBold,
        weight: 700,
        style: 'normal',
      },
    ],
  });

  // Convert SVG to PNG via resvg
  const resvg = new Resvg(svg, {
    fitTo: {
      mode: 'width',
      value: config.width,
    },
  });

  const pngData = resvg.render();
  const pngBuffer = pngData.asPng();

  // Determine output path
  const outputPath = args.output
    ? resolve(process.cwd(), args.output)
    : resolve(__dirname, 'output', `${templateName}.png`);

  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, pngBuffer);

  console.log(`Generated: ${outputPath}`);
  console.log(
    `Size: ${config.width}x${config.height}, ${(pngBuffer.length / 1024).toFixed(1)} KB`
  );
}

main().catch((err) => {
  console.error('Failed to generate OG image:', err);
  process.exit(1);
});
