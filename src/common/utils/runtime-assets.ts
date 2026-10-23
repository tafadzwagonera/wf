import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { appendToLogFile } from '../logger/log-file-writer';

interface SeaModule {
  isSea: () => boolean;
  getAsset: (key: string, encoding: 'utf8') => string;
}

interface ExtractRuntimeAssetParams {
  assetKey: string;
  destPath: string;
  mode: number;
}

const moduleRequire = createRequire(__filename);

const loadSea = (): SeaModule => moduleRequire('node:sea') as SeaModule;

const sha256 = (content: string): string => crypto.createHash('sha256').update(content).digest('hex');

const hasMode = (filePath: string, mode: number): boolean => {
  try {
    return (fs.statSync(filePath).mode & 0o777) === mode;
  } catch {
    return false;
  }
};

const writeAtomically = (destPath: string, content: string, mode: number): void => {
  const tempPath = `${destPath}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, content, { mode });
  fs.chmodSync(tempPath, mode);
  fs.renameSync(tempPath, destPath);
};

const readExistingText = (filePath: string): string | undefined => {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return undefined;
  }
};

export const isSeaRuntime = (): boolean => loadSea().isSea();

export const readRuntimeAsset = (assetKey: string, diskPath: string): string => {
  const sea = loadSea();
  return sea.isSea() ? sea.getAsset(assetKey, 'utf8') : fs.readFileSync(diskPath, 'utf8');
};

export const extractRuntimeAsset = ({ assetKey, destPath, mode }: ExtractRuntimeAssetParams): string => {
  const content = loadSea().getAsset(assetKey, 'utf8');
  const existing = readExistingText(destPath);
  const isCurrent = existing !== undefined && sha256(existing) === sha256(content) && hasMode(destPath, mode);
  if (isCurrent) return destPath;
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  writeAtomically(destPath, content, mode);
  appendToLogFile('INFO', `Extracted runtime asset ${assetKey} to ${destPath}`, 'sea');
  return destPath;
};
