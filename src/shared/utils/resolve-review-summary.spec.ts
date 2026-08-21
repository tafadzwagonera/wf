import * as fs from 'fs';
import * as path from 'path';
import {
  resolveReviewArtifactPath,
  readReviewArtifactSummary,
} from './resolve-review-summary';

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
