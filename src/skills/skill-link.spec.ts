import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { assertLinkable, syncLink } from './skill-link';

describe('syncLink', () => {
  let tmpDir: string;
  let source: string;
  let destination: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-link-'));
    source = path.join(tmpDir, 'source');
    destination = path.join(tmpDir, 'destination');
    fs.mkdirSync(source);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates a symlink and reports linked when the destination is missing', async () => {
    await expect(syncLink({ source, destination })).resolves.toBe('linked');
    expect(fs.readlinkSync(destination)).toBe(source);
  });

  it('reports ok when the symlink already points at the source', async () => {
    fs.symlinkSync(source, destination, 'dir');
    await expect(syncLink({ source, destination })).resolves.toBe('ok');
  });

  it('reports ok when the symlink target differs only by a trailing slash', async () => {
    fs.symlinkSync(`${source}/`, destination, 'dir');
    await expect(syncLink({ source, destination })).resolves.toBe('ok');
  });

  it('relinks a symlink that points elsewhere', async () => {
    const otherSource = path.join(tmpDir, 'other');
    fs.mkdirSync(otherSource);
    fs.symlinkSync(otherSource, destination, 'dir');
    await expect(syncLink({ source, destination })).resolves.toBe('relinked');
    expect(fs.readlinkSync(destination)).toBe(source);
  });

  it('throws without deleting when the destination is a real directory', async () => {
    fs.mkdirSync(destination);
    fs.writeFileSync(path.join(destination, 'SKILL.md'), 'keep');
    await expect(syncLink({ source, destination })).rejects.toThrow('not a symlink');
    expect(fs.readFileSync(path.join(destination, 'SKILL.md'), 'utf8')).toBe('keep');
  });
});

describe('assertLinkable', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-link-'));
  });

  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('resolves when the destination is missing', async () => {
    await expect(assertLinkable({ source: tmpDir, destination: path.join(tmpDir, 'missing') })).resolves.toBeUndefined();
  });

  it('throws when the destination is a real directory', async () => {
    const destination = path.join(tmpDir, 'real');
    fs.mkdirSync(destination);
    await expect(assertLinkable({ source: tmpDir, destination })).rejects.toThrow('not a symlink');
  });
});
