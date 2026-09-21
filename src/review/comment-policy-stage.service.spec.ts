import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { CommentPolicyStageService, mergeCommentPolicyIssues, toCodeIssues } from './comment-policy-stage.service';
import type { CodeReview } from '../shared/types/review.types';

function createMockConfigService(commentPolicy: boolean | undefined) {
  return {
    get: jest.fn((key: string) => (key === 'stages.review.commentPolicy' ? commentPolicy : undefined)),
  };
}

function makeDiff(file: string, hunks: string): string {
  return `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n${hunks}`;
}

const baseReview: CodeReview = {
  summary: 'ok',
  issues: [],
  suggestions: [],
  approved: true,
};

describe('CommentPolicyStageService', () => {
  let service: CommentPolicyStageService;

  async function build(commentPolicy?: boolean) {
    const module = await Test.createTestingModule({
      providers: [
        CommentPolicyStageService,
        { provide: ConfigService, useValue: createMockConfigService(commentPolicy) },
      ],
    }).compile();
    service = module.get(CommentPolicyStageService);
  }

  afterEach(() => jest.restoreAllMocks());

  describe('gate', () => {
    it('returns undefined when config is unset and force is absent', async () => {
      await build(undefined);
      const result = await service.scanIfEnabled({ diff: makeDiff('src/foo.ts', '@@ -1,1 +1,2 @@\n const x = 1;\n+// comment\n') });

      expect(result).toBeUndefined();
    });

    it('returns undefined when config is false and force is absent', async () => {
      await build(false);
      const result = await service.scanIfEnabled({ diff: makeDiff('src/foo.ts', '@@ -1,1 +1,2 @@\n const x = 1;\n+// comment\n') });

      expect(result).toBeUndefined();
    });

    it('runs when force is true even if config is disabled', async () => {
      await build(false);
      const result = await service.scanIfEnabled({ diff: makeDiff('src/foo.ts', '@@ -1,1 +1,2 @@\n const x = 1;\n+// comment\n'), force: true });

      expect(result).toBeDefined();
    });

    it('runs when stages.review.commentPolicy config is true', async () => {
      await build(true);
      const result = await service.scanIfEnabled({ diff: makeDiff('src/foo.ts', '@@ -1,1 +1,2 @@\n const x = 1;\n+// comment\n') });

      expect(result).toBeDefined();
    });
  });

  describe('diff parsing', () => {
    beforeEach(() => build(true));

    it('flags a new // line comment in a .ts file with correct destination line number', async () => {
      const diff = makeDiff('src/foo.ts', '@@ -1,2 +1,3 @@\n const x = 1;\n+// a comment\n const y = 2;\n');

      const result = await service.scanIfEnabled({ diff });

      expect(result?.findings).toHaveLength(1);
      expect(result?.findings[0]).toEqual({ file: 'src/foo.ts', line: 2 });
    });

    it('flags a trailing inline comment on a code line', async () => {
      const diff = makeDiff('src/foo.ts', '@@ -1,1 +1,2 @@\n const x = 1;\n+const y = 2; // inline\n');

      const result = await service.scanIfEnabled({ diff });

      expect(result?.findings).toHaveLength(1);
      expect(result?.findings[0].line).toBe(2);
    });

    it('flags a new /* */ block comment as one finding with correct line and endLine', async () => {
      const diff = makeDiff('src/foo.ts', '@@ -1,1 +1,4 @@\n const x = 1;\n+/*\n+ * block\n+ */\n');

      const result = await service.scanIfEnabled({ diff });

      expect(result?.findings).toHaveLength(1);
      expect(result?.findings[0]).toEqual({ file: 'src/foo.ts', line: 2, endLine: 4 });
    });

    it('flags a JSDoc block before a newly added export with no exemption', async () => {
      const diff = makeDiff('src/foo.ts', '@@ -1,1 +1,5 @@\n const x = 1;\n+/**\n+ * doc\n+ */\n+export function f() {}\n');

      const result = await service.scanIfEnabled({ diff });

      expect(result?.findings).toHaveLength(1);
      expect(result?.findings[0]).toMatchObject({ line: 2, endLine: 4 });
    });

    it('flags a JSDoc block before a non-exported symbol identically', async () => {
      const diff = makeDiff('src/foo.ts', '@@ -1,1 +1,5 @@\n const x = 1;\n+/**\n+ * doc\n+ */\n+function g() {}\n');

      const result = await service.scanIfEnabled({ diff });

      expect(result?.findings).toHaveLength(1);
      expect(result?.findings[0]).toMatchObject({ line: 2, endLine: 4 });
    });

    it('ignores comment text on context lines (no + prefix)', async () => {
      const diff = makeDiff('src/foo.ts', '@@ -1,2 +1,2 @@\n // existing comment\n+const x = 1;\n');

      const result = await service.scanIfEnabled({ diff });

      expect(result?.findings).toHaveLength(0);
    });

    it('ignores removed lines (- prefix)', async () => {
      const diff = makeDiff('src/foo.ts', '@@ -1,2 +1,1 @@\n-// removed comment\n const x = 1;\n');

      const result = await service.scanIfEnabled({ diff });

      expect(result?.findings).toHaveLength(0);
    });

    it('flags a # comment in a .yml file', async () => {
      const diff = makeDiff('deploy.yml', '@@ -1,1 +1,2 @@\n key: value\n+# a yaml comment\n');

      const result = await service.scanIfEnabled({ diff });

      expect(result?.findings).toHaveLength(1);
      expect(result?.findings[0]).toMatchObject({ file: 'deploy.yml', line: 2 });
    });

    it('flags <!-- --> block and // comment in the same .vue file', async () => {
      const diff = makeDiff('comp.vue', '@@ -1,1 +1,4 @@\n <div></div>\n+<!-- html comment -->\n+<script>\n+// js comment\n');

      const result = await service.scanIfEnabled({ diff });

      expect(result?.findings).toHaveLength(2);
    });

    it('skips files with unmapped extensions without throwing', async () => {
      const diff = makeDiff('README.md', '@@ -1,1 +1,2 @@\n # heading\n+<!-- comment -->\n');

      const result = await service.scanIfEnabled({ diff });

      expect(result?.findings).toHaveLength(0);
    });

    it('does not leak block-comment state across file boundaries', async () => {
      const diff
        = `diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,1 +1,2 @@\n const x = 1;\n+/*\n`
          + `diff --git a/b.ts b/b.ts\n--- a/b.ts\n+++ b/b.ts\n@@ -1,1 +1,2 @@\n const y = 2;\n+ * should not be in block\n`;

      const result = await service.scanIfEnabled({ diff });

      const bFindings = result?.findings.filter(f => f.file === 'b.ts');
      expect(bFindings).toHaveLength(0);
    });
  });

  describe('toCodeIssues', () => {
    it('maps a finding without endLine to a CodeIssue with origin "comment-policy"', () => {
      const issues = toCodeIssues([{ file: 'src/foo.ts', line: 5 }]);

      expect(issues).toHaveLength(1);
      expect(issues[0]).toMatchObject({
        severity: 'warning',
        origin: 'comment-policy',
        file: 'src/foo.ts',
        line: 5,
        message: '[comment-policy] Newly added comment requires human approval.',
      });
      expect(issues[0].endLine).toBeUndefined();
    });

    it('maps a finding with endLine to a CodeIssue with endLine set', () => {
      const issues = toCodeIssues([{ file: 'src/foo.ts', line: 3, endLine: 7 }]);

      expect(issues[0].endLine).toBe(7);
    });
  });

  describe('mergeCommentPolicyIssues', () => {
    it('returns the review unchanged when result is undefined', () => {
      const merged = mergeCommentPolicyIssues(baseReview, undefined);

      expect(merged).toBe(baseReview);
    });

    it('returns the review unchanged when findings are empty', () => {
      const merged = mergeCommentPolicyIssues(baseReview, { findings: [] });

      expect(merged).toBe(baseReview);
    });

    it('appends comment-policy issues to existing review issues', () => {
      const existing = { ...baseReview, issues: [{ severity: 'error' as const, message: 'existing' }] };
      const merged = mergeCommentPolicyIssues(existing, { findings: [{ file: 'src/a.ts', line: 1 }] });

      expect(merged.issues).toHaveLength(2);
      expect(merged.issues[1].origin).toBe('comment-policy');
    });
  });
});
