import * as fs from 'fs';
import * as path from 'path';
import * as wfPaths from '../utils/wf-paths';
import { appendToLogFile } from './log-file-writer';

describe('appendToLogFile', () => {
  afterEach(() => jest.restoreAllMocks());

  it('creates the log directory and appends a formatted line', () => {
    const fileSystem = require('fs') as typeof fs;
    jest.spyOn(wfPaths, 'getWfLogDir').mockReturnValue('/tmp/wf-logs');
    const existsSyncSpy = jest.spyOn(fileSystem, 'existsSync').mockReturnValue(false);
    const mkdirSyncSpy = jest.spyOn(fileSystem, 'mkdirSync').mockImplementation(() => undefined);
    const appendFileSyncSpy = jest.spyOn(fileSystem, 'appendFileSync').mockImplementation(() => undefined);

    appendToLogFile('ERROR', 'fatal message', 'ErrorHandler');

    expect(existsSyncSpy).toHaveBeenCalledWith('/tmp/wf-logs');
    expect(mkdirSyncSpy).toHaveBeenCalledWith('/tmp/wf-logs', { recursive: true });
    expect(appendFileSyncSpy).toHaveBeenCalledWith(
      path.join('/tmp/wf-logs', `agent-${new Date().toISOString().split('T')[0]}.log`),
      expect.stringContaining('[ERROR] [ErrorHandler] fatal message')
    );
  });

  it('swallows append failures without throwing', () => {
    const fileSystem = require('fs') as typeof fs;
    jest.spyOn(wfPaths, 'getWfLogDir').mockReturnValue('/tmp/wf-logs');
    jest.spyOn(fileSystem, 'existsSync').mockReturnValue(true);
    jest.spyOn(fileSystem, 'appendFileSync').mockImplementation(() => {
      throw new Error('disk full');
    });

    expect(() => appendToLogFile('ERROR', 'fatal message')).not.toThrow();
  });
});
