import * as fs from 'node:fs';
import * as path from 'node:path';
import { appendToLogFile } from '../logger/log-file-writer';
import { FileSystemError } from '../errors/app.error';
import { resolveCustomArtifactDir } from '../../agents/utils';

const VALID_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.tif', '.tiff', '.svg']);

const LOG_CONTEXT = 'ui-design-screenshots';

function filterAndMapImages(dir: string, entries: string[]): string[] {
  return entries
    .filter(e => VALID_EXTENSIONS.has(path.extname(e).toLowerCase()))
    .map(e => path.join(dir, e));
}

function resolveNoArgMode(repoBaseDir: string, identifier: string): string[] {
  const scanDir = path.join(resolveCustomArtifactDir(repoBaseDir), identifier);
  try {
    return filterAndMapImages(scanDir, fs.readdirSync(scanDir));
  } catch {
    appendToLogFile('WARN', `ui-design-screenshots: scan directory not found — ${scanDir}. Pass explicit file paths or place screenshots in that directory.`, LOG_CONTEXT);
    return [];
  }
}

function resolveSingleDirMode(resolved: string): string[] {
  return filterAndMapImages(resolved, fs.readdirSync(resolved));
}

function validateAndCollect(p: string, result: string[]): void {
  if (!fs.existsSync(p)) throw new FileSystemError(`ui-design-screenshots: file not found — ${p}`);
  const ext = path.extname(p).toLowerCase();
  if (!VALID_EXTENSIONS.has(ext)) {
    appendToLogFile('WARN', `ui-design-screenshots: unsupported extension ${ext} — ${p} skipped.`, LOG_CONTEXT);
    return;
  }
  result.push(p);
}

function resolveFileListMode(rawFiles: string[], repoBaseDir: string): string[] {
  const result: string[] = [];
  for (const raw of rawFiles) validateAndCollect(path.resolve(repoBaseDir, raw), result);
  return result;
}

function resolveSingleFile(rawFiles: string[], repoBaseDir: string): string[] {
  const resolved = path.resolve(repoBaseDir, rawFiles[0]);
  try {
    if (fs.statSync(resolved).isDirectory()) return resolveSingleDirMode(resolved);
  } catch { /* fall through */ }
  return resolveFileListMode(rawFiles, repoBaseDir);
}

export function resolveUiDesignScreenshots(
  rawFiles: string[], repoBaseDir: string, identifier: string,
): string[] {
  if (rawFiles.length === 0) return resolveNoArgMode(repoBaseDir, identifier);
  if (rawFiles.length === 1) return resolveSingleFile(rawFiles, repoBaseDir);
  return resolveFileListMode(rawFiles, repoBaseDir);
}
