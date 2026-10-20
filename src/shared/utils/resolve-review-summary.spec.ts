import * as fs from 'fs';
import * as path from 'path';
import * as YAML from 'yaml';
import {
  findExistingReviewArtifact,
  listReviewArtifactVariants,
  resolveCustomReviewArtifactPath,
  resolveReviewArtifactPath,
  readReviewArtifactSummary,
} from './resolve-review-summary';

describe('resolveCustomReviewArtifactPath', () => {
  it('returns a review path in the custom artifact dir, not the tracker dir', () => {
    const result = resolveCustomReviewArtifactPath('/tmp/current-app', 'my-plan');
    expect(result).toMatch(/current-app\/my-plan-review\.md$/);
    expect(result).not.toMatch(/jira|bitbucket/);
  });
});

describe('resolveReviewArtifactPath', () => {
  it('returns path ending with jira/TICKET_KEY-review.md', () => {
    const result = resolveReviewArtifactPath('/tmp/current-app', 'jira', 'WBP-123');
    expect(result).toMatch(/jira\/WBP-123-review\.md$/);
  });

  it('handles different tracker names', () => {
    const jiraPath = resolveReviewArtifactPath('/tmp/test-app', 'jira', 'TICKET-1');
    const bitbucketPath = resolveReviewArtifactPath('/tmp/test-app', 'bitbucket', 'TICKET-1');
    expect(jiraPath).toMatch(/jira\/TICKET-1-review\.md$/);
    expect(bitbucketPath).toMatch(/bitbucket\/TICKET-1-review\.md$/);
  });
});

describe('resolveReviewArtifactPath format variants', () => {
  it.each(['json', 'yaml', 'yml'] as const)('returns a -review.%s path for that format', format => {
    const result = resolveReviewArtifactPath('/tmp/current-app', 'jira', 'WBP-123', format);
    expect(result).toMatch(new RegExp(`jira/WBP-123-review\\.${format}$`));
  });

  it('returns a custom-dir -review path in the requested format', () => {
    const result = resolveCustomReviewArtifactPath('/tmp/current-app', 'my-plan', 'json');
    expect(result).toMatch(/current-app\/my-plan-review\.json$/);
  });
});

describe('listReviewArtifactVariants', () => {
  it('lists one candidate per supported format sharing the stem', () => {
    const variants = listReviewArtifactVariants('/tmp/.wf/app/jira/WBP-1-review.md');
    expect(variants).toEqual([
      '/tmp/.wf/app/jira/WBP-1-review.json',
      '/tmp/.wf/app/jira/WBP-1-review.md',
      '/tmp/.wf/app/jira/WBP-1-review.yaml',
      '/tmp/.wf/app/jira/WBP-1-review.yml',
    ]);
  });
});

describe('findExistingReviewArtifact', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join('/tmp', 'find-review-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('finds the artifact when it was written in a different format', () => {
    const yamlPath = path.join(tmpDir, 'WBP-1-review.yaml');
    fs.writeFileSync(yamlPath, 'summary: x', 'utf-8');

    expect(findExistingReviewArtifact(path.join(tmpDir, 'WBP-1-review.md'))).toBe(yamlPath);
  });

  it('returns null when no variant exists', () => {
    expect(findExistingReviewArtifact(path.join(tmpDir, 'WBP-1-review.md'))).toBeNull();
  });
});

describe('readReviewArtifactSummary', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join('/tmp', 'resolve-review-'));
  });

  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns null when file does not exist', () => {
    const nonexistent = path.join(tmpDir, 'nonexistent.md');
    const result = readReviewArtifactSummary(nonexistent);
    expect(result).toBeNull();
  });

  it('extracts summary from full-workflow markdown format', () => {
    const content = `# Code Review: WBP-123

## Summary
This change refactors the auth module for clarity.

## Issues
- Issue 1
- Issue 2`;
    const filePath = path.join(tmpDir, 'review.md');
    fs.writeFileSync(filePath, content, 'utf-8');

    const result = readReviewArtifactSummary(filePath);
    expect(result).toBe('This change refactors the auth module for clarity.');
  });

  it('extracts summary from standalone cache text format with ISSUES FOUND', () => {
    const content = `SUMMARY:
This change adds JWT validation.

ISSUES FOUND (2):
1. [error] Missing null check
2. [warning] Performance issue`;
    const filePath = path.join(tmpDir, 'review.txt');
    fs.writeFileSync(filePath, content, 'utf-8');

    const result = readReviewArtifactSummary(filePath);
    expect(result).toBe('This change adds JWT validation.');
  });

  it('extracts summary from standalone cache text format with ISSUES: None', () => {
    const content = `SUMMARY:
Bug fix for token refresh race condition.

ISSUES: None
APPROVAL STATUS: Approved`;
    const filePath = path.join(tmpDir, 'review-none.txt');
    fs.writeFileSync(filePath, content, 'utf-8');

    const result = readReviewArtifactSummary(filePath);
    expect(result).toBe('Bug fix for token refresh race condition.');
  });

  it('returns null when neither format matches', () => {
    const content = 'This is just a plain text file with no structured summary.';
    const filePath = path.join(tmpDir, 'plain.txt');
    fs.writeFileSync(filePath, content, 'utf-8');

    const result = readReviewArtifactSummary(filePath);
    expect(result).toBeNull();
  });

  it('returns null when summary is empty', () => {
    const content = `# Code Review: WBP-1

## Summary


## Issues
None`;
    const filePath = path.join(tmpDir, 'empty-summary.md');
    fs.writeFileSync(filePath, content, 'utf-8');

    const result = readReviewArtifactSummary(filePath);
    expect(result).toBeNull();
  });

  it('extracts the first target summary from a JSON cache artifact', () => {
    const reviewed = [{ title: 'T', diff: 'd', review: { summary: 'JSON summary text.', approved: true } }];
    const filePath = path.join(tmpDir, 'review.json');
    fs.writeFileSync(filePath, JSON.stringify(reviewed, null, 2), 'utf-8');

    expect(readReviewArtifactSummary(filePath)).toBe('JSON summary text.');
  });

  it.each(['yaml', 'yml'] as const)('extracts the first target summary from a %s cache artifact', extension => {
    const reviewed = [{ title: 'T', diff: 'd', review: { summary: 'YAML summary text.', approved: true } }];
    const filePath = path.join(tmpDir, `review.${extension}`);
    fs.writeFileSync(filePath, YAML.stringify(reviewed), 'utf-8');

    expect(readReviewArtifactSummary(filePath)).toBe('YAML summary text.');
  });

  it('returns null for a JSON artifact without a review summary', () => {
    const filePath = path.join(tmpDir, 'review.json');
    fs.writeFileSync(filePath, JSON.stringify([{ title: 'T', diff: 'd' }]), 'utf-8');

    expect(readReviewArtifactSummary(filePath)).toBeNull();
  });

  it('returns null for a malformed JSON artifact', () => {
    const filePath = path.join(tmpDir, 'review.json');
    fs.writeFileSync(filePath, '{not json', 'utf-8');

    expect(readReviewArtifactSummary(filePath)).toBeNull();
  });

  it('trims leading and trailing whitespace from summary', () => {
    const content = `# Code Review: WBP-1

## Summary
  \n  Trimmed summary with whitespace  \n

## Issues
None`;
    const filePath = path.join(tmpDir, 'trim-test.md');
    fs.writeFileSync(filePath, content, 'utf-8');

    const result = readReviewArtifactSummary(filePath);
    expect(result).toBe('Trimmed summary with whitespace');
  });
});
