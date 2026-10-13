import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { isWithinRoot, isWritablePathWithinRoot, resolveWritablePath } from './path-within-root';

describe('path-within-root', () => {
  let tmpDir: string;
  let root: string;
  let outside: string;

  beforeEach(() => {
    tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wf-root-')));
    root = path.join(tmpDir, 'repo');
    outside = path.join(tmpDir, 'outside');
    fs.mkdirSync(root);
    fs.mkdirSync(outside);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('accepts a path inside the root', () => {
    expect(isWithinRoot(path.join(root, 'a.ts'), root)).toBe(true);
    expect(isWritablePathWithinRoot(path.join(root, 'a.ts'), root)).toBe(true);
  });

  it('rejects a ".." escape', () => {
    const escaped = path.resolve(root, '..', 'outside', 'a.ts');
    expect(isWithinRoot(escaped, root)).toBe(false);
    expect(isWritablePathWithinRoot(escaped, root)).toBe(false);
  });

  it('rejects a path that escapes through a symlink', () => {
    fs.symlinkSync(outside, path.join(root, 'link'));
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'x');
    expect(isWritablePathWithinRoot(path.join(root, 'link', 'secret.txt'), root)).toBe(false);
    expect(isWritablePathWithinRoot(path.join(root, 'link', 'new.txt'), root)).toBe(false);
  });

  it('resolveWritablePath returns in-root paths and throws for escapes', () => {
    const inside = path.join(root, 'a.ts');
    expect(resolveWritablePath(inside, root, 'a.ts')).toBe(inside);
    expect(() => resolveWritablePath(path.join(outside, 'a.ts'), root, '../outside/a.ts')).toThrow('outside the primary');
  });
});
