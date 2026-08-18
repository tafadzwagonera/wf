import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { IssueTrackerService } from '../../integrations/issue-trackers/issue-tracker.service';
import { FetchStageService } from './fetch-stage.service';
import * as agentUtils from '../../agents/utils';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createTempDir as createManagedTempDir } from '../../shared/testing/temp-dir';

describe('FetchStageService', () => {
  let originalHome: string | undefined;
  const testHomeDir = path.join(os.tmpdir(), 'wf-fetch-home');
  const mockTicket = {
    key: 'WBP-123',
    title: 'Fix broken auth flow',
    description: 'Restore the login flow',
    type: 'bug',
    status: 'in_progress',
    priority: 'high',
    labels: ['auth'],
  };

  const buildService = async () => {
    const adapter = {
      getTicket: jest.fn().mockResolvedValue(mockTicket),
    };
    const module = await Test.createTestingModule({
      providers: [
        FetchStageService,
        {
          provide: IssueTrackerService,
          useValue: {
            getAdapter: jest.fn().mockReturnValue(adapter),
          },
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest
              .fn()
              .mockImplementation((key: string) => (key === 'atlassian.bitbucket.workspace' ? 'workspace' : undefined)),
          },
        },
      ],
    }).compile();

    return {
      service: module.get(FetchStageService),
      adapter,
      issueTrackerService: module.get(IssueTrackerService),
    };
  };

  const mockResolveArtifactDir = () => {
    jest.spyOn(agentUtils, 'resolveArtifactDir').mockImplementation((baseDir: string, trackerName: string) =>
      path.join(testHomeDir, '.wf', path.basename(path.resolve(baseDir)), trackerName)
    );
  };

  afterEach(() => {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    jest.restoreAllMocks();
    if (fs.existsSync(testHomeDir)) {
      fs.rmSync(testHomeDir, { recursive: true, force: true });
    }
  });

  it('fetches a ticket using a formatted Bitbucket reference for repo names', async () => {
    const { service, adapter } = await buildService();

    await service.fetchTicket('123', {
      trackerName: 'bitbucket',
      repo: 'service-api',
    });

    expect(adapter.getTicket).toHaveBeenCalledWith('workspace/service-api#123');
  });

  it('persists a markdown ticket artifact under the requested base directory', async () => {
    const { service } = await buildService();
    const tempBaseDir = createManagedTempDir('fetch');
    mockResolveArtifactDir();

    const artifact = await service.fetchArtifact('WBP-123', {
      trackerName: 'jira',
      baseDir: path.join(tempBaseDir, 'consumer-app'),
    });

    expect(artifact.path).toBe(path.join(testHomeDir, '.wf', 'consumer-app', 'jira', 'WBP-123.md'));
    expect(fs.readFileSync(artifact.path, 'utf-8')).toContain('# WBP-123: Fix broken auth flow');
  });

  it('reuses the existing artifact when skipExisting is true', async () => {
    const { service, adapter } = await buildService();
    const tempBaseDir = createManagedTempDir('fetch');
    const baseDir = path.join(tempBaseDir, 'consumer-app');
    mockResolveArtifactDir();
    const artifactDir = path.join(testHomeDir, '.wf', 'consumer-app', 'jira');
    fs.mkdirSync(artifactDir, { recursive: true });
    const ticketPath = path.join(artifactDir, 'WBP-123.md');
    fs.writeFileSync(ticketPath, '# WBP-123: Cached Ticket');

    const artifact = await service.fetchArtifact('WBP-123', {
      trackerName: 'jira',
      baseDir,
      skipExisting: true,
    });

    expect(artifact.fromCache).toBe(true);
    expect(artifact.content).toContain('Cached Ticket');
    expect(adapter.getTicket).not.toHaveBeenCalled();
  });
});
