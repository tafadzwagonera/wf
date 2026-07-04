import { detectTestInfra, detectTestPatterns, formatTestInfraPromptSection } from './detect-test-infra';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const createTempRepo = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'wf-infra-'));

describe('detectTestInfra', () => {
  describe('Node.js ecosystem', () => {
    it('detects node ecosystem when package.json exists', () => {
      const dir = createTempRepo();
      fs.writeFileSync(
        path.join(dir, 'package.json'),
        JSON.stringify({ scripts: { test: 'jest', build: 'nest build' }, devDependencies: { jest: '^30' } })
      );

      const ctx = detectTestInfra(dir);

      expect(ctx.primary).toBe('node');
      expect(ctx.ecosystems).toHaveLength(1);
      const node = ctx.ecosystems[0];
      expect(node.ecosystem).toBe('node');
      if (node.ecosystem !== 'node') return;
      expect(node.frameworks).toEqual(['jest']);
      expect(node.scripts).toEqual({ test: 'jest', build: 'nest build' });
    });

    it('reads node version from engines field', () => {
      const dir = createTempRepo();
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ engines: { node: '>=22' }, scripts: {} }));

      const ctx = detectTestInfra(dir);
      const node = ctx.ecosystems[0];
      if (node.ecosystem !== 'node') return;
      expect(node.nodeVersionMajor).toBe(22);
      expect(node.hasNodeTest).toBe(true);
    });

    it('reads node version from .nvmrc', () => {
      const dir = createTempRepo();
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: {} }));
      fs.writeFileSync(path.join(dir, '.nvmrc'), '18\n');

      const ctx = detectTestInfra(dir);
      const node = ctx.ecosystems[0];
      if (node.ecosystem !== 'node') return;
      expect(node.nodeVersionMajor).toBe(18);
      expect(node.hasNodeTest).toBe(true);
    });

    it('reads node version from .node-version', () => {
      const dir = createTempRepo();
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: {} }));
      fs.writeFileSync(path.join(dir, '.node-version'), 'v20.11.0\n');

      const ctx = detectTestInfra(dir);
      const node = ctx.ecosystems[0];
      if (node.ecosystem !== 'node') return;
      expect(node.nodeVersionMajor).toBe(20);
    });

    it('reads node version from bitbucket-pipelines.yml', () => {
      const dir = createTempRepo();
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: {} }));
      fs.writeFileSync(path.join(dir, 'bitbucket-pipelines.yml'), 'image: node:22\n');

      const ctx = detectTestInfra(dir);
      const node = ctx.ecosystems[0];
      if (node.ecosystem !== 'node') return;
      expect(node.nodeVersionMajor).toBe(22);
    });

    it('returns hasNodeTest false for Node < 18', () => {
      const dir = createTempRepo();
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: {} }));
      fs.writeFileSync(path.join(dir, '.nvmrc'), '16');

      const ctx = detectTestInfra(dir);
      const node = ctx.ecosystems[0];
      if (node.ecosystem !== 'node') return;
      expect(node.hasNodeTest).toBe(false);
    });

    it('returns null nodeVersionMajor for unparseable .nvmrc', () => {
      const dir = createTempRepo();
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: {} }));
      fs.writeFileSync(path.join(dir, '.nvmrc'), 'lts/*');

      const ctx = detectTestInfra(dir);
      const node = ctx.ecosystems[0];
      if (node.ecosystem !== 'node') return;
      expect(node.nodeVersionMajor).toBeNull();
      expect(node.hasNodeTest).toBe(false);
    });

    it('detects multiple frameworks', () => {
      const dir = createTempRepo();
      fs.writeFileSync(
        path.join(dir, 'package.json'),
        JSON.stringify({ devDependencies: { jest: '^30', vitest: '^1' }, scripts: {} })
      );

      const ctx = detectTestInfra(dir);
      const node = ctx.ecosystems[0];
      if (node.ecosystem !== 'node') return;
      expect(node.frameworks).toEqual(['jest', 'vitest']);
    });

    it('exposes allScriptNames including non-relevant scripts', () => {
      const dir = createTempRepo();
      fs.writeFileSync(
        path.join(dir, 'package.json'),
        JSON.stringify({ scripts: { test: 'jest', start: 'node .', 'test:manual': 'ts-node' } })
      );

      const ctx = detectTestInfra(dir);
      const node = ctx.ecosystems[0];
      if (node.ecosystem !== 'node') return;
      expect(node.allScriptNames).toEqual(expect.arrayContaining(['test', 'start', 'test:manual']));
      expect(node.scripts).toHaveProperty('test');
      expect(node.scripts).toHaveProperty('test:manual');
      expect(node.scripts).not.toHaveProperty('start');
    });
  });

  describe('Terraform ecosystem', () => {
    it('detects terraform when .tf files exist', () => {
      const dir = createTempRepo();
      fs.writeFileSync(path.join(dir, 'main.tf'), 'resource "aws_s3_bucket" "b" {}');

      const ctx = detectTestInfra(dir);

      expect(ctx.primary).toBe('terraform');
      expect(ctx.ecosystems).toHaveLength(1);
      const tf = ctx.ecosystems[0];
      expect(tf.ecosystem).toBe('terraform');
      if (tf.ecosystem !== 'terraform') return;
      expect(tf.hasTfFiles).toBe(true);
      expect(tf.hasBackendConfig).toBe(false);
    });

    it('detects backend configuration', () => {
      const dir = createTempRepo();
      fs.writeFileSync(path.join(dir, 'backend.tf'), 'terraform {\n  backend "s3" {}\n}');

      const ctx = detectTestInfra(dir);
      const tf = ctx.ecosystems[0];
      if (tf.ecosystem !== 'terraform') return;
      expect(tf.hasBackendConfig).toBe(true);
    });
  });

  describe('Python ecosystem', () => {
    it('detects python when pyproject.toml exists', () => {
      const dir = createTempRepo();
      fs.writeFileSync(path.join(dir, 'pyproject.toml'), '[tool.pytest]\n');

      const ctx = detectTestInfra(dir);

      expect(ctx.primary).toBe('python');
      const py = ctx.ecosystems[0];
      if (py.ecosystem !== 'python') return;
      expect(py.frameworks).toEqual(['pytest']);
    });

    it('detects python from requirements.txt', () => {
      const dir = createTempRepo();
      fs.writeFileSync(path.join(dir, 'requirements.txt'), 'pytest==7.4\ntox==4.0\n');

      const ctx = detectTestInfra(dir);
      const py = ctx.ecosystems[0];
      if (py.ecosystem !== 'python') return;
      expect(py.frameworks).toEqual(['pytest', 'tox']);
      expect(py.hasRequirementsTxt).toBe(true);
    });
  });

  describe('Go ecosystem', () => {
    it('detects go when go.mod exists', () => {
      const dir = createTempRepo();
      fs.writeFileSync(path.join(dir, 'go.mod'), 'module example.com/foo\n\ngo 1.21\n');

      const ctx = detectTestInfra(dir);

      expect(ctx.primary).toBe('go');
      const go = ctx.ecosystems[0];
      if (go.ecosystem !== 'go') return;
      expect(go.hasGoMod).toBe(true);
    });
  });

  describe('mixed ecosystems', () => {
    it('detects node + terraform with node as primary', () => {
      const dir = createTempRepo();
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'jest' } }));
      fs.writeFileSync(path.join(dir, 'main.tf'), 'resource "null_resource" "x" {}');

      const ctx = detectTestInfra(dir);

      expect(ctx.ecosystems).toHaveLength(2);
      expect(ctx.primary).toBe('node');
      expect(ctx.ecosystems.map(e => e.ecosystem)).toEqual(['node', 'terraform']);
    });
  });

  describe('empty repo', () => {
    it('returns no ecosystems and defaults primary to node', () => {
      const dir = createTempRepo();

      const ctx = detectTestInfra(dir);

      expect(ctx.ecosystems).toHaveLength(0);
      expect(ctx.primary).toBe('node');
    });
  });
});

describe('formatTestInfraPromptSection', () => {
  it('returns POSIX fallback when no ecosystems detected', () => {
    const output = formatTestInfraPromptSection({ ecosystems: [], primary: 'node' });
    expect(output).toContain('No test infrastructure detected');
    expect(output).toContain('POSIX shell commands');
  });

  it('includes node details in output', () => {
    const output = formatTestInfraPromptSection({
      ecosystems: [
        {
          ecosystem: 'node',
          nodeVersionMajor: 22,
          hasNodeTest: true,
          frameworks: ['jest'],
          scripts: { test: 'jest --coverage', lint: 'eslint .' },
          allScriptNames: ['test', 'lint', 'start'],
        },
      ],
      primary: 'node',
    });

    expect(output).toContain('Node.js: v22');
    expect(output).toContain('node:test and node:assert available');
    expect(output).toContain('Frameworks: jest');
    expect(output).toContain('test ("jest --coverage")');
    expect(output).toContain('Reference ONLY');
    expect(output).toContain('copy-paste-runnable');
  });

  it('includes terraform details in output', () => {
    const output = formatTestInfraPromptSection({
      ecosystems: [{ ecosystem: 'terraform', hasTfFiles: true, hasBackendConfig: true }],
      primary: 'terraform',
    });

    expect(output).toContain('Terraform files detected with backend configuration');
    expect(output).toContain('terraform validate');
    expect(output).toContain('terraform plan -target=module.foo');
  });

  it('includes go details in output', () => {
    const output = formatTestInfraPromptSection({
      ecosystems: [{ ecosystem: 'go', hasGoMod: true }],
      primary: 'go',
    });

    expect(output).toContain('Go module detected');
    expect(output).toContain('go test ./...');
  });

  it('includes python details in output', () => {
    const output = formatTestInfraPromptSection({
      ecosystems: [{ ecosystem: 'python', frameworks: ['pytest', 'tox'], hasRequirementsTxt: true }],
      primary: 'python',
    });

    expect(output).toContain('Python project detected');
    expect(output).toContain('Frameworks: pytest, tox');
  });

  it('includes allowlist block for node repos', () => {
    const output = formatTestInfraPromptSection({
      ecosystems: [
        {
          ecosystem: 'node',
          nodeVersionMajor: 22,
          hasNodeTest: true,
          frameworks: ['jest'],
          scripts: { test: 'jest', build: 'nest build' },
          allScriptNames: ['test', 'build'],
        },
      ],
      primary: 'node',
    });

    expect(output).toContain('Allowed verification command forms');
    expect(output).toContain('node -e "..."');
    expect(output).toContain('sh -c "..." / bash -c "..."');
    expect(output).toContain('yarn test -- ...');
    expect(output).toContain('yarn build -- ...');
  });

  it('includes shell-safety guidance for inline node commands', () => {
    const output = formatTestInfraPromptSection({
      ecosystems: [
        {
          ecosystem: 'node',
          nodeVersionMajor: 22,
          hasNodeTest: true,
          frameworks: ['jest'],
          scripts: { test: 'jest' },
          allScriptNames: ['test'],
        },
      ],
      primary: 'node',
    });

    expect(output).toContain('Verification commands MUST be shell-safe by construction.');
    expect(output).toContain('single-quoted JS strings or properly escaped backticks');
  });

  it('includes test conventions block when testPatterns is defined', () => {
    const output = formatTestInfraPromptSection({
      ecosystems: [
        {
          ecosystem: 'node',
          nodeVersionMajor: 22,
          hasNodeTest: true,
          frameworks: ['jest'],
          scripts: { test: 'jest' },
          allScriptNames: ['test'],
          testPatterns: {
            fileSuffix: '.spec',
            mockPrefix: 'mock',
            mockFactoryPrefix: 'createMock',
            describeStyle: 'nested',
            helperPaths: ['src/test/helpers.ts'],
            mockCleanup: null,
            diSetupPattern: null,
            errorHandlerExits: false,
          },
        },
      ],
      primary: 'node',
    });

    expect(output).toContain('Test conventions detected');
    expect(output).toContain('*.spec.ts');
    expect(output).toContain('prefix mocks with "mock"');
    expect(output).toContain('createMock');
    expect(output).toContain('nested describe blocks');
    expect(output).toContain('src/test/helpers.ts');
    expect(output).toContain('Follow these patterns');
  });

  it('omits test conventions block when testPatterns is undefined', () => {
    const output = formatTestInfraPromptSection({
      ecosystems: [
        {
          ecosystem: 'node',
          nodeVersionMajor: 22,
          hasNodeTest: true,
          frameworks: ['jest'],
          scripts: { test: 'jest' },
          allScriptNames: ['test'],
        },
      ],
      primary: 'node',
    });

    expect(output).not.toContain('Test conventions detected');
  });

  it('includes mockCleanup in test conventions when set', () => {
    const output = formatTestInfraPromptSection({
      ecosystems: [
        {
          ecosystem: 'node',
          nodeVersionMajor: 22,
          hasNodeTest: true,
          frameworks: ['jest'],
          scripts: { test: 'jest' },
          allScriptNames: ['test'],
          testPatterns: {
            fileSuffix: '.spec',
            mockPrefix: 'mock',
            mockFactoryPrefix: null,
            describeStyle: 'flat',
            helperPaths: [],
            mockCleanup: 'restoreAllMocks',
            diSetupPattern: null,
            errorHandlerExits: false,
          },
        },
      ],
      primary: 'node',
    });

    expect(output).toContain('Mock isolation: always prescribe `jest.restoreAllMocks()` in afterEach()');
    expect(output).toContain('do NOT leave cleanup steps as conditional');
  });

  it('omits mockCleanup line when mockCleanup is null', () => {
    const output = formatTestInfraPromptSection({
      ecosystems: [
        {
          ecosystem: 'node',
          nodeVersionMajor: 22,
          hasNodeTest: true,
          frameworks: ['jest'],
          scripts: { test: 'jest' },
          allScriptNames: ['test'],
          testPatterns: {
            fileSuffix: '.spec',
            mockPrefix: null,
            mockFactoryPrefix: null,
            describeStyle: 'flat',
            helperPaths: [],
            mockCleanup: null,
            diSetupPattern: null,
            errorHandlerExits: false,
          },
        },
      ],
      primary: 'node',
    });

    expect(output).not.toContain('Mock isolation: always prescribe');
  });

  it('includes DI test setup for testing-module', () => {
    const output = formatTestInfraPromptSection({
      ecosystems: [
        {
          ecosystem: 'node',
          nodeVersionMajor: 22,
          hasNodeTest: true,
          frameworks: ['jest'],
          scripts: { test: 'jest' },
          allScriptNames: ['test'],
          testPatterns: {
            fileSuffix: '.spec',
            mockPrefix: null,
            mockFactoryPrefix: null,
            describeStyle: 'flat',
            helperPaths: [],
            mockCleanup: null,
            diSetupPattern: 'testing-module',
            errorHandlerExits: false,
          },
        },
      ],
      primary: 'node',
    });

    expect(output).toContain('DI test setup: tests use a testing-module pattern');
    expect(output).toContain('State which DI framework you assume so the implementer can verify');
  });

  it('includes DI test setup for factory-function', () => {
    const output = formatTestInfraPromptSection({
      ecosystems: [
        {
          ecosystem: 'node',
          nodeVersionMajor: 22,
          hasNodeTest: true,
          frameworks: ['jest'],
          scripts: { test: 'jest' },
          allScriptNames: ['test'],
          testPatterns: {
            fileSuffix: '.spec',
            mockPrefix: null,
            mockFactoryPrefix: null,
            describeStyle: 'flat',
            helperPaths: [],
            mockCleanup: null,
            diSetupPattern: 'factory-function',
            errorHandlerExits: false,
          },
        },
      ],
      primary: 'node',
    });

    expect(output).toContain('DI test setup: tests use factory helpers');
    expect(output).toContain('State which factory you assume so the implementer can verify');
  });

  it('includes errorHandlerExits line when true', () => {
    const output = formatTestInfraPromptSection({
      ecosystems: [
        {
          ecosystem: 'node',
          nodeVersionMajor: 22,
          hasNodeTest: true,
          frameworks: ['jest'],
          scripts: { test: 'jest' },
          allScriptNames: ['test'],
          testPatterns: {
            fileSuffix: '.spec',
            mockPrefix: null,
            mockFactoryPrefix: null,
            describeStyle: 'flat',
            helperPaths: [],
            mockCleanup: null,
            diSetupPattern: null,
            errorHandlerExits: true,
          },
        },
      ],
      primary: 'node',
    });

    expect(output).toContain('Error handler: ErrorHandler.handle() calls process.exit(1)');
    expect(output).toContain('tests MUST mock process.exit before invoking code');
  });

  it('omits errorHandlerExits line when false', () => {
    const output = formatTestInfraPromptSection({
      ecosystems: [
        {
          ecosystem: 'node',
          nodeVersionMajor: 22,
          hasNodeTest: true,
          frameworks: ['jest'],
          scripts: { test: 'jest' },
          allScriptNames: ['test'],
          testPatterns: {
            fileSuffix: '.spec',
            mockPrefix: null,
            mockFactoryPrefix: null,
            describeStyle: 'flat',
            helperPaths: [],
            mockCleanup: null,
            diSetupPattern: null,
            errorHandlerExits: false,
          },
        },
      ],
      primary: 'node',
    });

    expect(output).not.toContain('Error handler: ErrorHandler.handle()');
  });
});

describe('detectTestPatterns', () => {
  describe('.spec suffix detection', () => {
    it('returns fileSuffix .spec when >= 80% of files use .spec', () => {
      const dir = createTempRepo();
      fs.mkdirSync(path.join(dir, 'src'));
      for (let i = 0; i < 9; i++) {
        fs.writeFileSync(path.join(dir, 'src', `file${i}.spec.ts`), 'describe("x", () => { it("y", () => {}); })');
      }
      fs.writeFileSync(path.join(dir, 'src', 'other.test.ts'), 'describe("x", () => { it("y", () => {}); })');

      const result = detectTestPatterns(dir);

      expect(result?.fileSuffix).toBe('.spec');
    });
  });

  describe('.test suffix detection', () => {
    it('returns fileSuffix .test when >= 80% of files use .test', () => {
      const dir = createTempRepo();
      fs.mkdirSync(path.join(dir, 'src'));
      for (let i = 0; i < 9; i++) {
        fs.writeFileSync(path.join(dir, 'src', `file${i}.test.ts`), 'describe("x", () => { it("y", () => {}); })');
      }
      fs.writeFileSync(path.join(dir, 'src', 'other.spec.ts'), 'describe("x", () => { it("y", () => {}); })');

      const result = detectTestPatterns(dir);

      expect(result?.fileSuffix).toBe('.test');
    });
  });

  describe('mixed suffix detection', () => {
    it('returns fileSuffix mixed when neither suffix reaches 80%', () => {
      const dir = createTempRepo();
      fs.mkdirSync(path.join(dir, 'src'));
      for (let i = 0; i < 5; i++) {
        fs.writeFileSync(path.join(dir, 'src', `a${i}.spec.ts`), 'it("x", () => {})');
      }
      for (let i = 0; i < 5; i++) {
        fs.writeFileSync(path.join(dir, 'src', `b${i}.test.ts`), 'it("x", () => {})');
      }

      const result = detectTestPatterns(dir);

      expect(result?.fileSuffix).toBe('mixed');
    });
  });

  describe('mock prefix detection', () => {
    it('detects mockPrefix when const mock[A-Z] pattern is found', () => {
      const dir = createTempRepo();
      fs.mkdirSync(path.join(dir, 'src'));
      fs.writeFileSync(path.join(dir, 'src', 'user.spec.ts'), 'const mockUser = {};\nit("x", () => {})');

      const result = detectTestPatterns(dir);

      expect(result?.mockPrefix).toBe('mock');
    });

    it('returns null mockPrefix when pattern is absent', () => {
      const dir = createTempRepo();
      fs.mkdirSync(path.join(dir, 'src'));
      fs.writeFileSync(path.join(dir, 'src', 'user.spec.ts'), 'it("x", () => {})');

      const result = detectTestPatterns(dir);

      expect(result?.mockPrefix).toBeNull();
    });
  });

  describe('factory prefix detection', () => {
    it('detects mockFactoryPrefix when createMock[A-Z] pattern is found', () => {
      const dir = createTempRepo();
      fs.mkdirSync(path.join(dir, 'src'));
      fs.writeFileSync(path.join(dir, 'src', 'user.spec.ts'), 'const createMockUser = () => ({});\nit("x", () => {})');

      const result = detectTestPatterns(dir);

      expect(result?.mockFactoryPrefix).toBe('createMock');
    });

    it('returns null mockFactoryPrefix when pattern is absent', () => {
      const dir = createTempRepo();
      fs.mkdirSync(path.join(dir, 'src'));
      fs.writeFileSync(path.join(dir, 'src', 'user.spec.ts'), 'it("x", () => {})');

      const result = detectTestPatterns(dir);

      expect(result?.mockFactoryPrefix).toBeNull();
    });
  });

  describe('nested describe detection', () => {
    it('returns describeStyle nested when majority of files have 2+ describe calls', () => {
      const dir = createTempRepo();
      fs.mkdirSync(path.join(dir, 'src'));
      const nested = 'describe("outer", () => { describe("inner", () => { it("x", () => {}); }); });';
      for (let i = 0; i < 4; i++) {
        fs.writeFileSync(path.join(dir, 'src', `file${i}.spec.ts`), nested);
      }
      fs.writeFileSync(path.join(dir, 'src', 'flat.spec.ts'), 'describe("only", () => { it("x", () => {}); })');

      const result = detectTestPatterns(dir);

      expect(result?.describeStyle).toBe('nested');
    });

    it('returns describeStyle flat when majority of files have fewer than 2 describe calls', () => {
      const dir = createTempRepo();
      fs.mkdirSync(path.join(dir, 'src'));
      for (let i = 0; i < 4; i++) {
        fs.writeFileSync(path.join(dir, 'src', `file${i}.spec.ts`), 'describe("only", () => { it("x", () => {}); })');
      }

      const result = detectTestPatterns(dir);

      expect(result?.describeStyle).toBe('flat');
    });
  });

  describe('helper path detection', () => {
    it('returns helperPaths for matching files', () => {
      const dir = createTempRepo();
      fs.mkdirSync(path.join(dir, 'src'));
      fs.writeFileSync(path.join(dir, 'src', 'user.spec.ts'), 'it("x", () => {})');
      fs.mkdirSync(path.join(dir, 'src', 'test-utils'));
      fs.writeFileSync(path.join(dir, 'src', 'test-utils', 'index.ts'), '');

      const result = detectTestPatterns(dir);

      expect(result?.helperPaths.some(p => p.includes('test-utils'))).toBe(true);
    });
  });

  describe('no test files', () => {
    it('returns undefined when no test files exist', () => {
      const dir = createTempRepo();
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: {} }));

      const result = detectTestPatterns(dir);

      expect(result).toBeUndefined();
    });
  });

  describe('mockCleanup detection', () => {
    it('detects restoreAllMocks when it dominates afterEach blocks', () => {
      const dir = createTempRepo();
      fs.mkdirSync(path.join(dir, 'src'));
      for (let i = 0; i < 3; i++) {
        fs.writeFileSync(
          path.join(dir, 'src', `file${i}.spec.ts`),
          'afterEach(() => { jest.restoreAllMocks(); }); it("x", () => {})'
        );
      }
      fs.writeFileSync(path.join(dir, 'src', 'other.spec.ts'), 'it("x", () => {})');

      const result = detectTestPatterns(dir);

      expect(result?.mockCleanup).toBe('restoreAllMocks');
    });

    it('returns null mockCleanup when no cleanup calls exist', () => {
      const dir = createTempRepo();
      fs.mkdirSync(path.join(dir, 'src'));
      fs.writeFileSync(path.join(dir, 'src', 'test.spec.ts'), 'it("x", () => {})');

      const result = detectTestPatterns(dir);

      expect(result?.mockCleanup).toBeNull();
    });

    it('detects resetAllMocks when it dominates', () => {
      const dir = createTempRepo();
      fs.mkdirSync(path.join(dir, 'src'));
      for (let i = 0; i < 3; i++) {
        fs.writeFileSync(
          path.join(dir, 'src', `file${i}.spec.ts`),
          'afterEach(() => { jest.resetAllMocks(); }); it("x", () => {})'
        );
      }

      const result = detectTestPatterns(dir);

      expect(result?.mockCleanup).toBe('resetAllMocks');
    });

    it('detects clearAllMocks when it dominates', () => {
      const dir = createTempRepo();
      fs.mkdirSync(path.join(dir, 'src'));
      for (let i = 0; i < 3; i++) {
        fs.writeFileSync(
          path.join(dir, 'src', `file${i}.spec.ts`),
          'afterEach(() => { jest.clearAllMocks(); }); it("x", () => {})'
        );
      }

      const result = detectTestPatterns(dir);

      expect(result?.mockCleanup).toBe('clearAllMocks');
    });
  });

  describe('diSetupPattern detection', () => {
    it('detects testing-module when Test.createTestingModule is present', () => {
      const dir = createTempRepo();
      fs.mkdirSync(path.join(dir, 'src'));
      fs.writeFileSync(
        path.join(dir, 'src', 'test.spec.ts'),
        'const module = Test.createTestingModule({ ... }); it("x", () => {})'
      );

      const result = detectTestPatterns(dir);

      expect(result?.diSetupPattern).toBe('testing-module');
    });

    it('detects factory-function when buildCommand is present', () => {
      const dir = createTempRepo();
      fs.mkdirSync(path.join(dir, 'src'));
      fs.writeFileSync(path.join(dir, 'src', 'test.spec.ts'), 'const cmd = buildCommand({ ... }); it("x", () => {})');

      const result = detectTestPatterns(dir);

      expect(result?.diSetupPattern).toBe('factory-function');
    });

    it('detects factory-function when buildAgent is present', () => {
      const dir = createTempRepo();
      fs.mkdirSync(path.join(dir, 'src'));
      fs.writeFileSync(path.join(dir, 'src', 'test.spec.ts'), 'const agent = buildAgent({ ... }); it("x", () => {})');

      const result = detectTestPatterns(dir);

      expect(result?.diSetupPattern).toBe('factory-function');
    });

    it('returns null diSetupPattern when neither pattern is present', () => {
      const dir = createTempRepo();
      fs.mkdirSync(path.join(dir, 'src'));
      fs.writeFileSync(path.join(dir, 'src', 'test.spec.ts'), 'it("x", () => {})');

      const result = detectTestPatterns(dir);

      expect(result?.diSetupPattern).toBeNull();
    });
  });

  describe('errorHandlerExits detection', () => {
    it('returns true when src/ file contains both handle( and process.exit(1)', () => {
      const dir = createTempRepo();
      fs.mkdirSync(path.join(dir, 'src'));
      fs.writeFileSync(
        path.join(dir, 'src', 'error-handler.ts'),
        'class ErrorHandler { handle() { process.exit(1); } }'
      );
      fs.writeFileSync(path.join(dir, 'src', 'test.spec.ts'), 'it("x", () => {})');

      const result = detectTestPatterns(dir);

      expect(result?.errorHandlerExits).toBe(true);
    });

    it('returns false when handle( is absent', () => {
      const dir = createTempRepo();
      fs.mkdirSync(path.join(dir, 'src'));
      fs.writeFileSync(path.join(dir, 'src', 'util.ts'), 'process.exit(1);');
      fs.writeFileSync(path.join(dir, 'src', 'test.spec.ts'), 'it("x", () => {})');

      const result = detectTestPatterns(dir);

      expect(result?.errorHandlerExits).toBe(false);
    });

    it('returns false when process.exit(1) is absent', () => {
      const dir = createTempRepo();
      fs.mkdirSync(path.join(dir, 'src'));
      fs.writeFileSync(path.join(dir, 'src', 'handler.ts'), 'class Handler { handle() { return; } }');
      fs.writeFileSync(path.join(dir, 'src', 'test.spec.ts'), 'it("x", () => {})');

      const result = detectTestPatterns(dir);

      expect(result?.errorHandlerExits).toBe(false);
    });

    it('returns false when no src/ file matches both patterns', () => {
      const dir = createTempRepo();
      fs.mkdirSync(path.join(dir, 'src'));
      fs.writeFileSync(path.join(dir, 'src', 'test.spec.ts'), 'it("x", () => {})');

      const result = detectTestPatterns(dir);

      expect(result?.errorHandlerExits).toBe(false);
    });

    it('returns false when src/ directory does not exist', () => {
      const dir = createTempRepo();
      fs.writeFileSync(path.join(dir, 'root.spec.ts'), 'it("x", () => {})');

      const result = detectTestPatterns(dir);

      expect(result?.errorHandlerExits).toBe(false);
    });
  });
});
