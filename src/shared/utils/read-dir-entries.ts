import * as fs from 'fs';

// Returns [] instead of propagating to ErrorHandler.handle when the directory cannot be read.
export const readDirEntries = (dir: string): fs.Dirent[] => {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
};
