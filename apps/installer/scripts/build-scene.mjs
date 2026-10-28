// Compile the homepage's actual renderer; keep the deployed installer self-contained.
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
const source = new URL('../../../packages/ui/src/glass/', import.meta.url);
const output = new URL('../public/scene/', import.meta.url);
await mkdir(output, { recursive: true });
for (const name of ['node-field', 'field-model', 'palette']) {
  const input = await readFile(new URL(`${name}.ts`, source), 'utf8');
  const { outputText } = ts.transpileModule(input, {
    fileName: fileURLToPath(new URL(`${name}.ts`, source)),
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
  });
  await writeFile(
    new URL(`${name}.js`, output),
    outputText.replace(/from '(\.\/[^']+)'/g, "from '$1.js'")
  );
}
