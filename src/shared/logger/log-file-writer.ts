import * as fs from 'fs';
import * as path from 'path';
import { getWfLogDir } from '../utils/wf-paths';

export const appendToLogFile = (level: string, message: string, context?: string): void => {
  const logDirectory = getWfLogDir();
  const logFile = path.join(logDirectory, `agent-${new Date().toISOString().split('T')[0]}.log`);
  const timestamp = new Date().toISOString();
  const contextLabel = context ? `[${context}] ` : '';

  try {
    if (!fs.existsSync(logDirectory)) {
      fs.mkdirSync(logDirectory, { recursive: true });
    }
    fs.appendFileSync(logFile, `${timestamp} [${level}] ${contextLabel}${message}\n`);
  } catch {
    return;
  }
};
