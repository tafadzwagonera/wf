import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';

const lookupOnPath = (command: string): string | undefined => {
  try {
    const output = execFileSync('/bin/sh', ['-c', `command -v ${command}`], { encoding: 'utf8' }).trim();
    return output || undefined;
  } catch {
    return undefined;
  }
};

export const locateClaudeExecutable = (): string | undefined => {
  const found = lookupOnPath('claude');
  return found ? fs.realpathSync(found) : undefined;
};

export const isNodeOnPath = (): boolean => lookupOnPath('node') !== undefined;
