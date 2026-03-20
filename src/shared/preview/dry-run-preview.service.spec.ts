// Mock chalk before any imports so the service receives identity functions
jest.mock('chalk', () => {
  const identity = (s: any) => s;

  const makeChain = () => {
    const chain: any = identity;
    const colorNames = [
      'bold', 'dim', 'italic', 'underline', 'inverse', 'strikethrough',
      'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan',
      'white', 'gray', 'grey',
    ];
    colorNames.forEach((name) => { chain[name] = identity; });
    return chain;
  };

  const chalk = makeChain();
  // chalk.bold needs its own sub-properties (e.g. chalk.bold.blue)
  const boldChain = makeChain();
  chalk.bold = boldChain;

  return {
    default: chalk,
    ...chalk,
  };
});

import { Test } from '@nestjs/testing';
import { DryRunPreviewService } from './dry-run-preview.service';

describe('DryRunPreviewService', () => {
  let service: DryRunPreviewService;
  let mockConsoleLog: jest.SpyInstance;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [DryRunPreviewService],
    }).compile();
    service = module.get(DryRunPreviewService);
    mockConsoleLog = jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => mockConsoleLog.mockRestore());

  describe('previewApiCall', () => {
    it('renders method, endpoint, platform, and description', () => {
      service.previewApiCall({
        method: 'GET',
        endpoint: '/jira/issues/WBP-1',
        platform: 'jira',
        description: 'Fetch ticket',
      });
      expect(mockConsoleLog).toHaveBeenCalledTimes(2);
      const firstCall = mockConsoleLog.mock.calls[0][0] as string;
      expect(firstCall).toContain('GET');
      expect(firstCall).toContain('/jira/issues/WBP-1');
    });

    it('renders estimatedResponse when provided', () => {
      service.previewApiCall({
        method: 'POST',
        endpoint: '/v1/messages',
        platform: 'Claude',
        description: 'Generate plan',
        estimatedResponse: '{ "action": "fix" }',
      });
      const calls = mockConsoleLog.mock.calls.map((c) => c[0] as string);
      expect(calls.some((c) => c.includes('Response:'))).toBe(true);
      expect(calls.some((c) => c.includes('"action"'))).toBe(true);
    });

    it('omits estimatedResponse line when absent', () => {
      service.previewApiCall({
        method: 'GET',
        endpoint: '/x',
        platform: 'x',
        description: 'desc',
      });
      const calls = mockConsoleLog.mock.calls.map((c) => c[0] as string);
      expect(calls.every((c) => !c.includes('Response:'))).toBe(true);
    });

    it('renders payload when non-empty', () => {
      service.previewApiCall({
        method: 'POST',
        endpoint: '/x',
        platform: 'x',
        description: 'desc',
        payload: { title: 'Test' },
      });
      const calls = mockConsoleLog.mock.calls.map((c) => c[0] as string);
      expect(calls.some((c) => c.includes('Payload:'))).toBe(true);
    });

    it('omits payload line when empty', () => {
      service.previewApiCall({
        method: 'POST',
        endpoint: '/x',
        platform: 'x',
        description: 'desc',
        payload: {},
      });
      const calls = mockConsoleLog.mock.calls.map((c) => c[0] as string);
      expect(calls.every((c) => !c.includes('Payload:'))).toBe(true);
    });
  });

  describe('previewFileWrite', () => {
    it('renders create operation', () => {
      service.previewFileWrite({
        filePath: '/a/b/file.md',
        operation: 'create',
        sizeEstimate: '1 KB',
      });
      const firstCall = mockConsoleLog.mock.calls[0][0] as string;
      expect(firstCall).toContain('/a/b/file.md');
    });

    it('renders contentPreview lines when provided', () => {
      service.previewFileWrite({
        filePath: '/a/b/file.md',
        operation: 'create',
        sizeEstimate: '1 KB',
        contentPreview: 'line1\nline2\nline3',
      });
      expect(mockConsoleLog).toHaveBeenCalledTimes(4); // filepath + 3 lines
    });

    it('truncates contentPreview at 10 lines and appends ellipsis', () => {
      const preview = Array.from({ length: 15 }, (_, i) => `line${i}`).join('\n');
      service.previewFileWrite({
        filePath: '/x',
        operation: 'create',
        sizeEstimate: '1 KB',
        contentPreview: preview,
      });
      // 1 filepath + 10 content lines + 1 ellipsis = 12 calls
      expect(mockConsoleLog).toHaveBeenCalledTimes(12);
      const lastCall = mockConsoleLog.mock.calls[11][0] as string;
      expect(lastCall).toContain('...');
    });

    it('omits contentPreview block when absent', () => {
      service.previewFileWrite({
        filePath: '/x',
        operation: 'create',
        sizeEstimate: '1 KB',
      });
      expect(mockConsoleLog).toHaveBeenCalledTimes(1);
    });
  });

  describe('showTerminalOutput', () => {
    it('renders each line with │ prefix', () => {
      service.showTerminalOutput(['line A', 'line B']);
      const calls = mockConsoleLog.mock.calls.map((c) => c[0] as string);
      expect(calls.some((c) => c.includes('│ line A'))).toBe(true);
      expect(calls.some((c) => c.includes('│ line B'))).toBe(true);
    });

    it('is a no-op when lines array is empty', () => {
      service.showTerminalOutput([]);
      expect(mockConsoleLog).not.toHaveBeenCalled();
    });
  });

  describe('showSummary', () => {
    it('renders aggregated counts', () => {
      service.showSummary({
        apiCallCount: 2,
        fileCreatedCount: 1,
        fileModifiedCount: 0,
        gitOperationCount: 0,
      });
      const calls = mockConsoleLog.mock.calls.map((c) => c[0] as string);
      expect(calls.some((c) => c.includes('2 API calls'))).toBe(true);
      expect(calls.some((c) => c.includes('1 file created'))).toBe(true);
    });

    it('calls showTerminalOutput when terminalOutputLines provided', () => {
      const spy = jest.spyOn(service, 'showTerminalOutput');
      service.showSummary({
        apiCallCount: 0,
        fileCreatedCount: 0,
        fileModifiedCount: 0,
        gitOperationCount: 0,
        terminalOutputLines: ['✓ Done'],
      });
      expect(spy).toHaveBeenCalledWith(['✓ Done']);
    });

    it('does not call showTerminalOutput when field is absent', () => {
      const spy = jest.spyOn(service, 'showTerminalOutput');
      service.showSummary({
        apiCallCount: 0,
        fileCreatedCount: 0,
        fileModifiedCount: 0,
        gitOperationCount: 0,
      });
      expect(spy).not.toHaveBeenCalled();
    });
  });
});
