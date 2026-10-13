import * as fs from 'node:fs';
import * as path from 'node:path';
import { ValidationError } from './errors';

export const isWithinRoot = (absolutePath: string, root: string): boolean => {
  const rel = path.relative(root, absolutePath);
  return rel.length > 0 && !rel.startsWith('..');
};

const realpathOfNearestExistingAncestor = (absolutePath: string): string => {
  const resolved = path.resolve(absolutePath);
  try {
    return fs.realpathSync(resolved);
  } catch {
    const parent = path.dirname(resolved);
    return parent === resolved
      ? resolved
      : path.join(realpathOfNearestExistingAncestor(parent), path.basename(resolved));
  }
};

export const isWritablePathWithinRoot = (absolutePath: string, root: string): boolean => {
  const resolvedRoot = path.resolve(root);
  const lexicallyInside = absolutePath === resolvedRoot || isWithinRoot(absolutePath, resolvedRoot);
  if (!lexicallyInside) return false;
  const realRoot = realpathOfNearestExistingAncestor(resolvedRoot);
  const realTarget = realpathOfNearestExistingAncestor(absolutePath);
  return realTarget === realRoot || isWithinRoot(realTarget, realRoot);
};

export const resolveWritablePath = (absolutePath: string, primaryRoot: string, requestedPath: string): string => {
  if (!isWritablePathWithinRoot(absolutePath, primaryRoot)) {
    throw new ValidationError(`Write path is outside the primary repository: ${requestedPath}`, { path: requestedPath });
  }
  return absolutePath;
};
