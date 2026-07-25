import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { GitService } from './git.service';
import { LoggerService } from '../../shared/logger/logger.service';
import { GitError } from '../../shared/errors/app.error';

describe('GitService', () => {
  let service: GitService;
  let configService: ConfigService;
  let mockGit: any;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GitService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn(),
          },
        },
        {
          provide: LoggerService,
          useValue: {
            success: jest.fn(),
            warn: jest.fn(),
            error: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<GitService>(GitService);
    configService = module.get<ConfigService>(ConfigService);

    mockGit = {
      status: jest.fn(),
      push: jest.fn(),
    };
    Object.defineProperty(service, 'git', {
      value: mockGit,
      writable: true,
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('push() protected branch guard', () => {
    it('refuses push to main', async () => {
      (configService.get as jest.Mock).mockReturnValue(undefined);
      (mockGit.status as jest.Mock).mockResolvedValue({ current: 'main' });

      await expect(service.push()).rejects.toThrow(GitError);
      await expect(service.push()).rejects.toThrow('Refusing to push directly to protected branch');
    });

    it('refuses push to master', async () => {
      (configService.get as jest.Mock).mockReturnValue(undefined);
      (mockGit.status as jest.Mock).mockResolvedValue({ current: 'master' });

      await expect(service.push()).rejects.toThrow(GitError);
      await expect(service.push()).rejects.toThrow('Refusing to push directly to protected branch');
    });

    it('refuses push to develop', async () => {
      (configService.get as jest.Mock).mockReturnValue(undefined);
      (mockGit.status as jest.Mock).mockResolvedValue({ current: 'develop' });

      await expect(service.push()).rejects.toThrow(GitError);
      await expect(service.push()).rejects.toThrow('Refusing to push directly to protected branch');
    });

    it('strips origin/ prefix before matching', async () => {
      (configService.get as jest.Mock).mockReturnValue(undefined);

      await expect(service.push('origin', 'origin/main')).rejects.toThrow(GitError);
      await expect(service.push('origin', 'origin/main')).rejects.toThrow(
        'Refusing to push directly to protected branch'
      );
    });

    it('strips remotes/origin/ prefix before matching', async () => {
      (configService.get as jest.Mock).mockReturnValue(undefined);

      await expect(service.push('origin', 'remotes/origin/develop')).rejects.toThrow(GitError);
      await expect(service.push('origin', 'remotes/origin/develop')).rejects.toThrow(
        'Refusing to push directly to protected branch'
      );
    });

    it('allows push to feature/foo', async () => {
      (configService.get as jest.Mock).mockReturnValue(undefined);
      (mockGit.push as jest.Mock).mockResolvedValue(undefined);

      await service.push('origin', 'feature/foo');

      expect(mockGit.push).toHaveBeenCalled();
    });

    it('allows branches not in custom protectedBranches config', async () => {
      (configService.get as jest.Mock).mockReturnValue(['main', 'release']);
      (mockGit.push as jest.Mock).mockResolvedValue(undefined);

      await service.push('origin', 'develop');

      expect(mockGit.push).toHaveBeenCalled();
    });

    it('refuses branches in custom protectedBranches config', async () => {
      (configService.get as jest.Mock).mockReturnValue(['main', 'release']);

      await expect(service.push('origin', 'release')).rejects.toThrow(GitError);
      await expect(service.push('origin', 'release')).rejects.toThrow(
        'Refusing to push directly to protected branch'
      );
    });

    it('disables guard when protectedBranches is empty array', async () => {
      (configService.get as jest.Mock).mockReturnValue([]);
      (mockGit.push as jest.Mock).mockResolvedValue(undefined);

      await service.push('origin', 'main');

      expect(mockGit.push).toHaveBeenCalled();
    });

    it('performs case-insensitive branch matching', async () => {
      (configService.get as jest.Mock).mockReturnValue(undefined);

      await expect(service.push('origin', 'Main')).rejects.toThrow(GitError);
      await expect(service.push('origin', 'MASTER')).rejects.toThrow(GitError);
      await expect(service.push('origin', 'Develop')).rejects.toThrow(GitError);
    });
  });
});
