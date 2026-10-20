import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { commitDescriptionRecordSchema } from '../schemas/commit-description.schema';
import type { CommitDescriptionRecord, CommitDescriptionResponse } from '../types/commit-description.types';
import { stripSupportedPlanExtension } from './plan-artifact';

export const deriveCommitDescriptionPath = (reviewArtifactPath: string): string =>
  `${stripSupportedPlanExtension(reviewArtifactPath)}.commit-description.json`;

export const hashCommitDescriptionDiff = (diff: string): string =>
  createHash('sha256').update(diff).digest('hex');

export const readCommitDescriptionRecord = (filePath: string): CommitDescriptionRecord | null => {
  try {
    if (!fs.existsSync(filePath)) return null;
    const parsed = commitDescriptionRecordSchema.safeParse(JSON.parse(fs.readFileSync(filePath, 'utf-8')));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};

export const renderCommitDescriptionContext = (record: CommitDescriptionResponse | CommitDescriptionRecord): string =>
  `${record.description} (change nature: ${record.nature})`;
