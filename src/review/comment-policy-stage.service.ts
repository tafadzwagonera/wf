import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as path from 'node:path';
import { splitDiffByFile } from './summarise-diff';
import type { DiffSegment } from './summarise-diff';
import type { CodeIssue, CodeReview } from '../common/types/review.types';

export interface CommentPolicyStageOptions {
  diff: string;
  force?: boolean;
}

export interface CommentPolicyFinding {
  file: string;
  line: number;
  endLine?: number;
}

export interface CommentPolicyResult {
  findings: CommentPolicyFinding[];
}

interface CommentSyntax {
  lineTokens: string[];
  blockPairs: Array<{ start: string; end: string }>;
}

const jsSyntax: CommentSyntax = {
  lineTokens: ['//'],
  blockPairs: [{ start: '/*', end: '*/' }],
};

const HUNK_HEADER_RE = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

interface HunkWalkerState {
  destLine: number;
  blockEnd: string | null;
  blockStartLine: number;
}

const commentSyntaxByExtension: Record<string, CommentSyntax> = {
  '.ts': jsSyntax,
  '.tsx': jsSyntax,
  '.js': jsSyntax,
  '.jsx': jsSyntax,
  '.vue': {
    lineTokens: ['//'],
    blockPairs: [
      { start: '/*', end: '*/' },
      { start: '<!--', end: '-->' },
    ],
  },
  '.yml': { lineTokens: ['#'], blockPairs: [] },
  '.yaml': { lineTokens: ['#'], blockPairs: [] },
};

@Injectable()
export class CommentPolicyStageService {
  constructor(private readonly configService: ConfigService) {}

  async scanIfEnabled(options: CommentPolicyStageOptions): Promise<CommentPolicyResult | undefined> {
    const configEnabled = this.configService.get<boolean>('stages.review.commentPolicy') === true;
    if (!options.force && !configEnabled) return undefined;
    return { findings: this.scanDiff(options.diff) };
  }

  private scanDiff(diff: string): CommentPolicyFinding[] {
    return splitDiffByFile(diff).flatMap(segment => this.scanSegment(segment));
  }

  private scanSegment(segment: DiffSegment): CommentPolicyFinding[] {
    const syntax = commentSyntaxByExtension[path.extname(segment.file).toLowerCase()];
    if (!syntax) return [];
    const state: HunkWalkerState = { destLine: 0, blockEnd: null, blockStartLine: 0 };
    const findings: CommentPolicyFinding[] = [];
    for (const raw of segment.patch.split('\n')) {
      this.processLine(raw, segment.file, syntax, state, findings);
    }
    return findings;
  }

  private processLine(
    raw: string, file: string, syntax: CommentSyntax, state: HunkWalkerState, findings: CommentPolicyFinding[]
  ): void {
    const hunkHeader = HUNK_HEADER_RE.exec(raw);
    if (hunkHeader) {
      state.destLine = Number.parseInt(hunkHeader[1], 10) - 1;
      return;
    }
    const isRemoved = raw.startsWith('-') && !raw.startsWith('---');
    const isAdded = raw.startsWith('+') && !raw.startsWith('+++');
    if (!isRemoved) state.destLine++;
    if (!isAdded) return this.processContextLine(raw, file, state, findings);
    this.processAddedLine(raw.slice(1).trimStart(), file, syntax, state, findings);
  }

  private processContextLine(
    raw: string, file: string, state: HunkWalkerState, findings: CommentPolicyFinding[]
  ): void {
    if (raw.startsWith('-') && !raw.startsWith('---')) return;
    if (state.blockEnd === null) return;
    if (!raw.slice(1).trimStart().includes(state.blockEnd)) return;
    findings.push({ file, line: state.blockStartLine, endLine: state.destLine });
    state.blockEnd = null;
  }

  private processAddedLine(
    content: string, file: string, syntax: CommentSyntax, state: HunkWalkerState, findings: CommentPolicyFinding[]
  ): void {
    if (this.processInsideBlock(content, file, state, findings)) return;
    const matchedPair = syntax.blockPairs.find(p => content.includes(p.start));
    if (matchedPair) {
      this.processBlockStart(content, file, matchedPair, state, findings);
      return;
    }
    if (syntax.lineTokens.some(token => content.includes(token))) {
      findings.push({ file, line: state.destLine });
    }
  }

  private processInsideBlock(
    content: string, file: string, state: HunkWalkerState, findings: CommentPolicyFinding[]
  ): boolean {
    if (state.blockEnd === null) return false;
    if (content.includes(state.blockEnd)) {
      findings.push({ file, line: state.blockStartLine, endLine: state.destLine });
      state.blockEnd = null;
    }
    return true;
  }

  private processBlockStart(
    content: string, file: string, pair: { start: string; end: string },
    state: HunkWalkerState, findings: CommentPolicyFinding[]
  ): void {
    const afterStart = content.slice(content.indexOf(pair.start) + pair.start.length);
    if (afterStart.includes(pair.end)) {
      findings.push({ file, line: state.destLine });
    } else {
      state.blockEnd = pair.end;
      state.blockStartLine = state.destLine;
    }
  }
}

export function toCodeIssues(findings: CommentPolicyFinding[]): CodeIssue[] {
  return findings.map(f => ({
    severity: 'warning' as const,
    message: '[comment-policy] Newly added comment requires human approval.',
    file: f.file,
    line: f.line,
    ...(f.endLine === undefined ? {} : { endLine: f.endLine }),
    origin: 'comment-policy' as const,
  }));
}

export function mergeCommentPolicyIssues(review: CodeReview, result: CommentPolicyResult | undefined): CodeReview {
  if (!result?.findings.length) return review;
  return { ...review, issues: [...review.issues, ...toCodeIssues(result.findings)] };
}
