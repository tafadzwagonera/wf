import {
  detectCrossRepoPatterns,
  formatCrossRepoPatternsPromptSection,
  CrossRepoContext,
} from './detect-cross-repo-patterns';
import {
  detectRepoConventions,
  RepoConventionsContext,
} from './detect-repo-conventions';

jest.mock('./detect-repo-conventions');

const mockDetectRepoConventions = detectRepoConventions as jest.MockedFunction<
  typeof detectRepoConventions
>;

const createMockContext = (
  overrides: Partial<RepoConventionsContext> = {},
): RepoConventionsContext => ({
  language: 'typescript',
  linter: { tool: 'eslint', keyRules: {} },
  typescript: { strict: true, module: 'commonjs', target: 'ES2020', paths: {} },
  go: null,
  python: null,
  terraform: null,
  folderStructure: [],
  namingPattern: 'kebab-case',
  nestjsDetected: false,
  importStyle: 'commonjs',
  keyDependencies: ['jest'],
  errorHandlingPaths: [],
  ...overrides,
});

describe('detectCrossRepoPatterns', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('when secondary repos have identical conventions', () => {
    it('returns empty patterns', () => {
      const mockCtx = createMockContext();
      mockDetectRepoConventions.mockReturnValue(mockCtx);

      const result = detectCrossRepoPatterns('/primary', ['/secondary']);

      expect(result.patterns).toHaveLength(0);
    });
  });

  describe('when secondary repo uses a different linter tool', () => {
    it('detects different linter tools', () => {
      const primaryCtx = createMockContext({
        linter: { tool: 'eslint', keyRules: {} },
      });
      const secondaryCtx = createMockContext({
        linter: { tool: 'biome', keyRules: {} },
      });

      mockDetectRepoConventions
        .mockReturnValueOnce(primaryCtx)
        .mockReturnValueOnce(secondaryCtx);

      const result = detectCrossRepoPatterns('/primary', ['/repos/secondary']);

      expect(result.patterns).toHaveLength(1);
      expect(result.patterns[0].deltas).toContain(
        'secondary uses biome linter (primary uses eslint)',
      );
    });
  });

  describe('when secondary repo uses a different test framework', () => {
    it('detects different test frameworks', () => {
      const primaryCtx = createMockContext({ keyDependencies: ['jest'] });
      const secondaryCtx = createMockContext({ keyDependencies: ['vitest'] });

      mockDetectRepoConventions
        .mockReturnValueOnce(primaryCtx)
        .mockReturnValueOnce(secondaryCtx);

      const result = detectCrossRepoPatterns('/primary', ['/repos/secondary']);

      expect(result.patterns).toHaveLength(1);
      expect(result.patterns[0].deltas).toContain(
        'secondary uses vitest for testing (primary uses jest)',
      );
    });
  });

  describe('when secondary repo uses a different import style', () => {
    it('detects different import styles', () => {
      const primaryCtx = createMockContext({ importStyle: 'commonjs' });
      const secondaryCtx = createMockContext({ importStyle: 'esm' });

      mockDetectRepoConventions
        .mockReturnValueOnce(primaryCtx)
        .mockReturnValueOnce(secondaryCtx);

      const result = detectCrossRepoPatterns('/primary', ['/repos/secondary']);

      expect(result.patterns).toHaveLength(1);
      expect(result.patterns[0].deltas).toContain(
        'secondary uses esm imports (primary uses commonjs)',
      );
    });
  });

  describe('when secondary repo has error utilities the primary lacks', () => {
    it('detects error utilities present in secondary but not primary', () => {
      const primaryCtx = createMockContext({ errorHandlingPaths: [] });
      const secondaryCtx = createMockContext({
        errorHandlingPaths: ['/repos/secondary/src/utils/errors.ts'],
      });

      mockDetectRepoConventions
        .mockReturnValueOnce(primaryCtx)
        .mockReturnValueOnce(secondaryCtx);

      const result = detectCrossRepoPatterns('/primary', ['/repos/secondary']);

      expect(result.patterns).toHaveLength(1);
      expect(result.patterns[0].deltas).toContain(
        'secondary has error utility at /repos/secondary/src/utils/errors.ts',
      );
    });
  });

  describe('when secondary repo uses a different naming pattern', () => {
    it('detects different naming patterns', () => {
      const primaryCtx = createMockContext({ namingPattern: 'kebab-case' });
      const secondaryCtx = createMockContext({ namingPattern: 'camelCase' });

      mockDetectRepoConventions
        .mockReturnValueOnce(primaryCtx)
        .mockReturnValueOnce(secondaryCtx);

      const result = detectCrossRepoPatterns('/primary', ['/repos/secondary']);

      expect(result.patterns).toHaveLength(1);
      expect(result.patterns[0].deltas).toContain(
        'secondary uses camelCase naming (primary uses kebab-case)',
      );
    });
  });

  describe('when primary is TypeScript and secondary is Go', () => {
    it('detects language differences', () => {
      const primaryCtx = createMockContext({ language: 'typescript' });
      const secondaryCtx = createMockContext({
        language: 'go',
        go: { modulePath: 'github.com/org/secondary' },
        linter: null,
        typescript: null,
        keyDependencies: [],
        importStyle: 'unknown',
      });

      mockDetectRepoConventions
        .mockReturnValueOnce(primaryCtx)
        .mockReturnValueOnce(secondaryCtx);

      const result = detectCrossRepoPatterns('/primary', ['/repos/secondary']);

      expect(result.patterns).toHaveLength(1);
      expect(result.patterns[0].deltas).toContain(
        'secondary uses go (primary uses typescript)',
      );
    });
  });

  describe('when one secondary repo has no deltas', () => {
    it('skips repos with no deltas', () => {
      const primaryCtx = createMockContext();
      const identicalCtx = createMockContext();
      const differentCtx = createMockContext({ importStyle: 'esm' });

      mockDetectRepoConventions
        .mockReturnValueOnce(primaryCtx)
        .mockReturnValueOnce(identicalCtx)
        .mockReturnValueOnce(differentCtx);

      const result = detectCrossRepoPatterns('/primary', [
        '/repos/identical',
        '/repos/different',
      ]);

      expect(result.patterns).toHaveLength(1);
      expect(result.patterns[0].repoName).toBe('different');
    });
  });
});

describe('formatCrossRepoPatternsPromptSection', () => {
  describe('when there are no patterns', () => {
    it('returns empty string', () => {
      const ctx: CrossRepoContext = { patterns: [] };
      expect(formatCrossRepoPatternsPromptSection(ctx)).toBe('');
    });
  });

  describe('when there are patterns with deltas', () => {
    it('produces correct output', () => {
      const ctx: CrossRepoContext = {
        patterns: [
          {
            repoName: 'service-api',
            deltas: [
              'service-api uses esm imports (primary uses commonjs)',
              'service-api uses biome linter (primary uses eslint)',
            ],
          },
          {
            repoName: 'service-worker',
            deltas: [
              'service-worker uses vitest for testing (primary uses jest)',
            ],
          },
        ],
      };

      const result = formatCrossRepoPatternsPromptSection(ctx);

      expect(result).toBe(
        [
          'Patterns from related repositories:',
          'service-api:',
          '  - service-api uses esm imports (primary uses commonjs)',
          '  - service-api uses biome linter (primary uses eslint)',
          'service-worker:',
          '  - service-worker uses vitest for testing (primary uses jest)',
        ].join('\n'),
      );
    });
  });
});
