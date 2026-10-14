import { findConfigReadClusters, findFunctionsByName } from './find-existing-resolvers';
import { detectDuplicateResolverViolations } from './plan-quality-duplicate-resolver';

jest.mock('./find-existing-resolvers');

const REPO_DIR = '/repo';
const CLUSTER_FILE = 'src/integrations/ai/ai.service.ts';
const TWO_KEY_STEPS = ['Add a resolver reading `stages.implement.provider` and `ai.stages.plan.provider`.'];

const mockClusterLookup = jest.mocked(findConfigReadClusters);
const mockFunctionLookup = jest.mocked(findFunctionsByName);

describe('detecting duplicate resolvers in a plan', () => {
  beforeEach(() => {
    mockClusterLookup.mockResolvedValue([{ file: CLUSTER_FILE, line: 977, count: 2 }]);
    mockFunctionLookup.mockResolvedValue([]);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    mockClusterLookup.mockReset();
    mockFunctionLookup.mockReset();
  });

  it('reports a reuse risk when two config keys share a leaf that an existing file already reads', async () => {
    const violations = await detectDuplicateResolverViolations({
      steps: TWO_KEY_STEPS, affectedFiles: [], affectedRepositories: ['wf'], repoDir: REPO_DIR,
    });

    expect(mockClusterLookup).toHaveBeenCalledTimes(1);
    expect(mockClusterLookup.mock.calls[0]).toEqual([REPO_DIR, ['provider']]);
    expect(violations).toHaveLength(1);
    expect(violations[0].ruleId).toBe('duplicate-resolver');
    expect(violations[0].message).toContain('reuse');
    expect(violations[0].message).toContain(`${CLUSTER_FILE}:977`);
  });

  it('stays silent when the plan already lists the clustered file', async () => {
    const asString = await detectDuplicateResolverViolations({
      steps: TWO_KEY_STEPS, affectedFiles: [`wf/${CLUSTER_FILE}`], affectedRepositories: ['wf'], repoDir: REPO_DIR,
    });
    const asEntry = await detectDuplicateResolverViolations({
      steps: TWO_KEY_STEPS,
      affectedFiles: [{ filePath: `wf/${CLUSTER_FILE}` }] as never,
      affectedRepositories: ['wf'],
      repoDir: REPO_DIR,
    });

    expect(asString).toEqual([]);
    expect(asEntry).toEqual([]);
  });

  it('stays silent when only one config key is named', async () => {
    const violations = await detectDuplicateResolverViolations({
      steps: ['Read `stages.implement.provider` once.'], affectedFiles: [], affectedRepositories: [], repoDir: REPO_DIR,
    });

    expect(violations).toEqual([]);
    expect(mockClusterLookup).toHaveBeenCalledTimes(0);
  });

  it('ignores keys written without backticks or quotes', async () => {
    const violations = await detectDuplicateResolverViolations({
      steps: ['Read stages.implement.provider and ai.stages.plan.provider.'],
      affectedFiles: [],
      affectedRepositories: [],
      repoDir: REPO_DIR,
    });

    expect(violations).toEqual([]);
    expect(mockClusterLookup).toHaveBeenCalledTimes(0);
  });

  it('reports a reuse risk when the plan adds a function whose name already exists', async () => {
    mockClusterLookup.mockResolvedValue([]);
    mockFunctionLookup.mockResolvedValue([{ file: 'src/agents/pull.ts', line: 12, name: 'resolvePullAssessorSupport' }]);

    const violations = await detectDuplicateResolverViolations({
      steps: ['Next, add `resolvePullAssessorSupport` to the step verifier.'],
      affectedFiles: [],
      affectedRepositories: [],
      repoDir: REPO_DIR,
    });

    expect(mockFunctionLookup).toHaveBeenCalledTimes(1);
    expect(mockFunctionLookup.mock.calls[0]).toEqual([REPO_DIR, ['resolvePullAssessorSupport']]);
    expect(violations).toHaveLength(1);
    expect(violations[0].message).toContain('reuse resolvePullAssessorSupport in src/agents/pull.ts:12');
  });

  it('skips both lookups when no repository directory is known', async () => {
    const violations = await detectDuplicateResolverViolations({
      steps: [...TWO_KEY_STEPS, 'add `resolvePullAssessorSupport`'],
      affectedFiles: [],
      affectedRepositories: [],
      repoDir: undefined,
    });

    expect(violations).toEqual([]);
    expect(mockClusterLookup).toHaveBeenCalledTimes(0);
    expect(mockFunctionLookup).toHaveBeenCalledTimes(0);
  });

  it('stays silent when both lookups find nothing', async () => {
    mockClusterLookup.mockResolvedValue([]);

    const violations = await detectDuplicateResolverViolations({
      steps: [...TWO_KEY_STEPS, 'add `resolvePullAssessorSupport`'],
      affectedFiles: [],
      affectedRepositories: [],
      repoDir: REPO_DIR,
    });

    expect(violations).toEqual([]);
    expect(mockClusterLookup).toHaveBeenCalledTimes(1);
    expect(mockFunctionLookup).toHaveBeenCalledTimes(1);
  });
});
