import { inspect } from 'util';
import type {
  ReviewTraceCallStackNode,
  ReviewTraceValueChange,
  ReviewTraceStateNode,
  ReviewTraceStateTransition,
} from '../../shared/types/review.types';

export type {
  ReviewTraceCallStackNode,
  ReviewTraceValueChange,
  ReviewTraceStateNode,
  ReviewTraceStateTransition,
} from '../../shared/types/review.types';

const formatValue = (value: unknown): string => {
  if (typeof value === 'string') {
    return value;
  }

  if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') {
    return String(value);
  }

  if (value == null) {
    return String(value);
  }

  return inspect(value, {
    depth: 6,
    colors: false,
    compact: false,
    breakLength: 80,
    sorted: true,
  });
};

const indentMultilineValue = (value: string, indent: string): string =>
  value
    .split('\n')
    .map((line, index) => (index === 0 ? line : `${indent}${line}`))
    .join('\n');

const isReviewTraceValueChange = (value: unknown): value is ReviewTraceValueChange =>
  value !== null && typeof value === 'object' && ('before' in value || 'after' in value);

const normalizeCallStackNode = (node: ReviewTraceCallStackNode | string): ReviewTraceCallStackNode => {
  if (typeof node === 'string') {
    return { frame: node };
  }

  return {
    frame: node.frame,
    children: node.children?.map(normalizeCallStackNode),
  };
};

const normalizeStateNode = (node: ReviewTraceStateNode | Record<string, unknown>): ReviewTraceStateNode => {
  const typedNode = node as Partial<ReviewTraceStateNode> & Record<string, unknown>;

  if (typeof typedNode.frame === 'string') {
    const normalizedChanges: Record<string, ReviewTraceValueChange> | undefined
      = typedNode.changes && typeof typedNode.changes === 'object'
        ? Object.entries(typedNode.changes).reduce<Record<string, ReviewTraceValueChange>>((acc, [key, value]) => {
            if (isReviewTraceValueChange(value)) {
              acc[key] = value;
              return acc;
            }

            acc[key] = { after: value };
            return acc;
          }, {})
        : undefined;

    return {
      frame: typedNode.frame,
      captured: typedNode.captured && typeof typedNode.captured === 'object' ? typedNode.captured : undefined,
      changes: normalizedChanges,
      children: Array.isArray(typedNode.children)
        ? typedNode.children.map(child => normalizeStateNode(child as ReviewTraceStateNode | Record<string, unknown>))
        : undefined,
    };
  }

  const legacyState = typeof typedNode.state === 'string' ? typedNode.state : 'state';
  const legacyChanges: Record<string, ReviewTraceValueChange> = {};

  if ('state' in typedNode && typedNode.state !== undefined) {
    legacyChanges.state = { after: typedNode.state };
  }

  if ('next' in typedNode && typedNode.next !== undefined) {
    legacyChanges.next = { after: typedNode.next };
  }

  return {
    frame: legacyState,
    changes: Object.keys(legacyChanges).length > 0 ? legacyChanges : undefined,
    children: Array.isArray(typedNode.children)
      ? typedNode.children.map(child => normalizeStateNode(child as ReviewTraceStateNode | Record<string, unknown>))
      : undefined,
  };
};

const renderTree = (
  nodes: Array<ReviewTraceCallStackNode | string>,
  renderNode: (node: ReviewTraceCallStackNode) => string[],
  prefix = ''
): string[] => {
  const normalizedNodes = nodes.map(normalizeCallStackNode);

  return normalizedNodes.flatMap((node, index) => {
    const isLast = index === normalizedNodes.length - 1;
    const branch = isLast ? '└─' : '├─';
    const nextPrefix = `${prefix}${isLast ? '   ' : '│  '}`;
    const lines = [`${prefix}${branch} ${renderNode(node)[0]}`];

    if (node.children?.length) {
      lines.push(...renderTree(node.children, renderNode, nextPrefix));
    }

    const rendered = renderNode(node);
    if (rendered.length > 1) {
      lines.push(...rendered.slice(1).map(line => `${nextPrefix}${line}`));
    }

    return lines;
  });
};

const renderKeyValueLines = (values: Record<string, unknown>, prefix: string): string[] =>
  Object.entries(values).flatMap(([key, value], index, entries) => {
    const isLast = index === entries.length - 1;
    const branch = isLast ? '└─' : '├─';
    const valuePrefix = `${prefix}${isLast ? '   ' : '│  '}`;
    const formattedValue = indentMultilineValue(formatValue(value), `${valuePrefix}   `);

    return [`${prefix}${branch} ${key} = ${formattedValue}`];
  });

const renderStateNode = (node: ReviewTraceStateNode, prefix = '', isLast = true): string[] => {
  const branch = isLast ? '└─' : '├─';
  const lines = [`${prefix}${branch} ${node.frame}`];
  const childPrefix = `${prefix}${isLast ? '   ' : '│  '}`;

  if (node.captured && Object.keys(node.captured).length > 0) {
    const capturedBranch = node.children?.length || Object.keys(node.changes ?? {}).length ? '├─' : '└─';
    lines.push(`${childPrefix}${capturedBranch} captured`);
    const capturedContinuation = capturedBranch === '├─' ? '│  ' : '   ';
    lines.push(...renderKeyValueLines(node.captured, `${childPrefix}${capturedContinuation}`));
  }

  if (node.changes && Object.keys(node.changes).length > 0) {
    const hasChildren = Boolean(node.children?.length);
    lines.push(`${childPrefix}${hasChildren ? '├─' : '└─'} changes`);
    lines.push(
      ...Object.entries(node.changes).flatMap(([key, value], index, entries) => {
        const isLast = index === entries.length - 1;
        const branch = isLast ? '└─' : '├─';
        const valuePrefix = `${childPrefix}${hasChildren ? '│  ' : '   '}`;

        if (value && typeof value === 'object' && ('before' in value || 'after' in value)) {
          const change = value;
          const subIndent = isLast ? '   ' : '│  ';
          return [
            `${valuePrefix}${branch} ${key} =`,
            `${valuePrefix}${subIndent}├─ before = ${indentMultilineValue(
              formatValue(change.before),
              `${valuePrefix}${subIndent}   `
            )}`,
            `${valuePrefix}${subIndent}└─ after = ${indentMultilineValue(
              formatValue(change.after),
              `${valuePrefix}${subIndent}   `
            )}`,
          ];
        }

        return [`${valuePrefix}${branch} ${key} = ${indentMultilineValue(formatValue(value), `${valuePrefix}      `)}`];
      })
    );
  }

  if (node.children?.length) {
    lines.push(...renderStateNodes(node.children, childPrefix));
  }

  return lines;
};

const renderStateNodes = (nodes: Array<ReviewTraceStateNode | Record<string, unknown>>, prefix = ''): string[] => {
  const normalizedNodes = nodes.map(normalizeStateNode);

  return normalizedNodes.flatMap((node, index) => renderStateNode(node, prefix, index === normalizedNodes.length - 1));
};

/**
 * Format a review call stack as a nested tree.
 * @param callStack Structured call stack nodes or legacy string frames
 * @returns Tree-like text lines or an empty array when no frames were supplied
 */
export const formatReviewCallStack = (callStack?: Array<ReviewTraceCallStackNode | string>): string[] => {
  if (!callStack?.length) {
    return [];
  }

  return renderTree(callStack, node => [node.frame]).flatMap(line => line.split('\n'));
};

/**
 * Format a state transition tree with frame-aligned variable changes.
 * @param stateTransition Structured transition object or legacy JSON payload
 * @returns Tree-like text lines or an empty array when no transition was supplied
 */
export const formatReviewStateTransition = (
  stateTransition?: ReviewTraceStateTransition | Record<string, unknown>
): string[] => {
  if (!stateTransition || Object.keys(stateTransition).length === 0) {
    return [];
  }

  const lines: string[] = [];
  const structured = stateTransition as ReviewTraceStateTransition;

  if (structured.from) {
    lines.push(`from: ${structured.from}`);
  }

  if (structured.to) {
    lines.push(`to: ${structured.to}`);
  }

  if (structured.steps?.length) {
    if (lines.length > 0) {
      lines.push('');
    }

    lines.push(...renderStateNodes(structured.steps));
    return lines.flatMap(line => line.split('\n'));
  }

  return Object.entries(stateTransition)
    .flatMap(([key, value]) => {
      if (value && typeof value === 'object') {
        return [`${key}:`, indentMultilineValue(formatValue(value), '  ')];
      }

      return [`${key}: ${formatValue(value)}`];
    })
    .flatMap(line => line.split('\n'));
};
