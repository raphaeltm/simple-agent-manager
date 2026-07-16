import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { Project, SyntaxKind } from 'ts-morph';
import { describe, expect, it } from 'vitest';

function sourceFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    if (statSync(path).isDirectory()) files.push(...sourceFiles(path));
    else if (path.endsWith('.ts')) files.push(path);
  }
  return files;
}

describe('task-backed chat writer inventory', () => {
  it('forbids production ProjectData session writers from passing a null taskId', () => {
    const srcRoot = resolve(process.cwd(), 'src');
    const project = new Project({ useInMemoryFileSystem: true });
    const violations: string[] = [];
    let candidateFiles = 0;

    for (const file of sourceFiles(srcRoot)) {
      const contents = readFileSync(file, 'utf8');
      if (!contents.includes('projectDataService.createSession')) continue;
      candidateFiles += 1;

      const source = project.createSourceFile(relative(srcRoot, file), contents, {
        overwrite: true,
      });
      for (const call of source.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        const expression = call.getExpression().getText();
        if (expression !== 'projectDataService.createSession') continue;

        const taskId = call.getArguments()[4];
        if (!taskId || taskId.getKind() === SyntaxKind.NullKeyword) {
          const position = source.getLineAndColumnAtPos(call.getStart());
          violations.push(
            `${relative(srcRoot, file)}:${position.line} passes ${taskId?.getText() ?? 'no'} taskId`
          );
        }
      }
    }

    expect(candidateFiles).toBeGreaterThan(0);
    expect(violations).toEqual([]);
  });
});
