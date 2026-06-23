import { detectTestInfra, formatTestInfraPromptSection } from './detect-test-infra';
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
});
