/**
 * The absolute path of an operator tool (pnpm, docker, bash, sh), looked up in the operator's
 * PATH before it is spawned. These scripts run on the box owner's own machine and trust its
 * PATH, but only its absolute entries: a relative entry such as `.` or an empty one (the current
 * directory) is skipped, so a file planted in the working directory can never stand in for a
 * tool. Failing here also names the missing tool instead of a bare spawn ENOENT.
 */
import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';

export function commandPath(name: string, pathEnv: string = process.env.PATH ?? ''): string {
  if (isAbsolute(name)) return name;
  for (const dir of pathEnv.split(delimiter)) {
    if (!isAbsolute(dir)) continue;
    const candidate = join(dir, name);
    try {
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Not here, or not executable: keep looking.
    }
  }
  throw new Error(`${name} was not found on PATH (absolute PATH entries only)`);
}
