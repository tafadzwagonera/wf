import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  buildPlanArtifactFilename,
  buildPlanArtifactManifest,
  buildPlanArtifactManifestPath,
  hashPlanArtifactSources,
  writePlanArtifactManifest,
} from '../../../src/common/utils/plan-artifact';
import type { ResolutionAction } from '../../../src/common/types/agent.types';

export type SeedPlanArtifactOptions = {
  artifactDir: string;
  sourceName: string;
  action: ResolutionAction;
  plan: Record<string, unknown>;
  sourceKind?: 'ticket' | 'custom';
  createdAt?: Date;
};

export type SeededPlanArtifact = {
  artifactPath: string;
  manifestPath: string;
  hash: string;
};

export const seedPlanArtifact = (options: SeedPlanArtifactOptions): SeededPlanArtifact => {
  const createdAt = options.createdAt ?? new Date();
  const hash = hashPlanArtifactSources([options.sourceName]);
  const artifactPath = path.join(
    options.artifactDir,
    buildPlanArtifactFilename({ createdAt, hash, action: options.action, format: 'json' }),
  );
  fs.mkdirSync(options.artifactDir, { recursive: true });
  fs.writeFileSync(artifactPath, JSON.stringify(options.plan, null, 2), 'utf-8');
  writePlanArtifactManifest(buildPlanArtifactManifest({
    artifactPath, hash, createdAt, format: 'json', action: options.action,
    sourceName: options.sourceName, sourceKind: options.sourceKind ?? 'ticket',
  }));
  return { artifactPath, manifestPath: buildPlanArtifactManifestPath(artifactPath), hash };
};
