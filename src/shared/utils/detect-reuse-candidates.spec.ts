import * as path from 'node:path';

jest.mock('./walk-dir');

import { walkDir, buildSkipDirs } from './walk-dir';
import { detectReuseCandidates, formatReuseCandidatesPromptSection } from './detect-reuse-candidates';

const mockWalkDir = walkDir as jest.MockedFunction<typeof walkDir>;
const mockBuildSkipDirs = buildSkipDirs as jest.MockedFunction<typeof buildSkipDirs>;

const REPO_DIR = '/fake/repo';

describe('detectReuseCandidates', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  beforeEach(() => {
    mockBuildSkipDirs.mockReturnValue(new Set(['node_modules']));
  });

  it('returns a match when ticket tokens overlap 2+ significant filename tokens', () => {
    mockWalkDir.mockImplementation(dir => {
      if (String(dir).includes('components')) {
        return [path.join(REPO_DIR, 'app/components/StoriesFeedFilters.vue')];
      }
      return [];
    });

    const result = detectReuseCandidates(
      REPO_DIR,
      'Add filtering capability to the stories feed section',
    );

    expect(result).toBeDefined();
    expect(result?.candidates).toHaveLength(1);
    expect(result?.candidates[0].name).toBe('StoriesFeedFilters.vue');
  });

  it('never throws and returns undefined when walkDir throws (unreadable directory)', () => {
    mockWalkDir.mockImplementation(() => {
      throw new Error('ENOENT');
    });
    expect(() => detectReuseCandidates(REPO_DIR, 'stories feed filter section')).not.toThrow();
    expect(detectReuseCandidates(REPO_DIR, 'stories feed filter section')).toBeUndefined();
  });

  it('returns undefined when ticketContent is empty', () => {
    mockWalkDir.mockReturnValue([]);
    expect(detectReuseCandidates(REPO_DIR, '')).toBeUndefined();
  });

  it('returns undefined when ticket has only generic vocabulary below the 2-token match threshold', () => {
    mockWalkDir.mockImplementation(dir => {
      if (String(dir).includes('components')) {
        return [path.join(REPO_DIR, 'app/components/BaseButton.vue')];
      }
      return [];
    });
    const result = detectReuseCandidates(REPO_DIR, 'update the button color');
    expect(result).toBeUndefined();
  });
});

describe('formatReuseCandidatesPromptSection', () => {
  it('returns empty string for undefined context', () => {
    expect(formatReuseCandidatesPromptSection(undefined)).toBe('');
  });

  it('returns empty string for empty candidates array', () => {
    expect(formatReuseCandidatesPromptSection({ candidates: [] })).toBe('');
  });

  it('hard-caps output at 3000 characters', () => {
    const manyFiles = Array.from({ length: 200 }, (_, i) => ({
      name: `VeryLongComponentName${i}.vue`,
      relativePath: `app/components/VeryLongComponentName${i}.vue`,
    }));
    const result = formatReuseCandidatesPromptSection({ candidates: manyFiles });
    expect(result.length).toBeLessThanOrEqual(3000);
  });
});
