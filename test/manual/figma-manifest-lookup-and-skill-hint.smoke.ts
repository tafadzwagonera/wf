/**
 * Manual smoke test: FigmaStageService finds manifest via artifactDir and
 * ReviewerAgent builds the correct Skill hint string
 *
 * Verifies two related behaviours introduced in the same change:
 *   1. resolveIfEnabled with artifactDir finds a manifest in the tracker-
 *      namespaced directory — previously only the custom artifact dir was
 *      searched, so ticket-plan manifests were never found at review time.
 *   2. ReviewerAgent.buildFigmaSkillHint constructs the expected
 *      Skill('figma-design-check', ...) string from the resolved result.
 *
 * Run: nr test:manual -- figma-manifest-lookup-and-skill-hint.smoke
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execSync } from 'node:child_process';
import chalk from 'chalk';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { FigmaStageService } from '../../src/review/figma-stage.service';
import { ReviewerAgent } from '../../src/agents/reviewer.agent';
import { ConfigService } from '@nestjs/config';
import {
  buildPlanArtifactManifest,
  writePlanArtifactManifest,
  buildPlanArtifactManifestPath,
} from '../../src/shared/utils/plan-artifact';
import { createReporter } from './support/reporter';

const { counts, pass, fail } = createReporter();

function initGitBranch(dir: string, branch: string): void {
  execSync('git init -q', { cwd: dir });
  execSync('git config user.email "test@example.com"', { cwd: dir });
  execSync('git config user.name "Test"', { cwd: dir });
  fs.writeFileSync(path.join(dir, '.gitkeep'), '');
  execSync('git add .gitkeep', { cwd: dir });
  execSync('git commit -q -m "init"', { cwd: dir });
  execSync(`git checkout -q -b ${branch}`, { cwd: dir });
}

async function main(): Promise<void> {
  console.log('Manual smoke: FigmaStageService manifest lookup via artifactDir + skill hint\n');

  const wfHome = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-figma-manifest-'));
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-figma-repo-'));
  const origWfHome = process.env.WF_HOME;
  process.env.WF_HOME = wfHome;

  const branch = 'feature/WF-42-figma-smoke';
  const figmaLinks = ['https://www.figma.com/design/abc123/Component--Frame-1'];
  const sourceBranch = 'main';

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  const figmaStageService = app.get(FigmaStageService);
  const reviewerAgent = app.get(ReviewerAgent);
  const configService = app.get(ConfigService);

  const originalGet = configService.get.bind(configService);
  (configService as unknown as Record<string, unknown>)['get'] = (key: string, ...rest: unknown[]) => {
    if (key === 'stages.review.figma') return true;
    return originalGet(key, ...rest);
  };

  try {
    initGitBranch(repoDir, branch);

    const artifactDir = path.join(wfHome, path.basename(repoDir), 'jira');
    fs.mkdirSync(artifactDir, { recursive: true });

    const artifactPath = path.join(artifactDir, '2026-08-30-abcd1234-feature-plan.json');
    fs.writeFileSync(artifactPath, JSON.stringify({ steps: [] }));

    const manifest = buildPlanArtifactManifest({
      artifactPath,
      action: 'feature',
      format: 'json',
      hash: 'abcd1234',
      sourceName: 'WF-42',
      sourceKind: 'ticket',
      createdAt: new Date('2026-08-30T12:00:00Z'),
      trackerName: 'jira',
      figmaLinks,
    });
    const manifestWithBranch = { ...manifest, branchName: branch, sourceBranch };
    writePlanArtifactManifest(manifestWithBranch);

    const manifestPath = buildPlanArtifactManifestPath(artifactPath);
    if (fs.existsSync(manifestPath)) {
      pass(`Manifest written to ${path.basename(path.dirname(manifestPath))}/${path.basename(manifestPath)}`);
    } else {
      fail('Manifest file was not created', manifestPath);
    }

    console.log(chalk.bold.cyan('\nTest 1: resolveIfEnabled finds figmaLinks via artifactDir'));

    const result = await figmaStageService.resolveIfEnabled({
      repoDir,
      force: true,
      artifactDir,
    });

    if (!result) {
      fail('resolveIfEnabled returned undefined — manifest was not found via artifactDir');
    } else if (result.figmaLinks.length === 1 && result.figmaLinks[0] === figmaLinks[0]) {
      pass('resolveIfEnabled returned correct figmaLinks from tracker-namespaced manifest');
    } else {
      fail('resolveIfEnabled returned unexpected figmaLinks', JSON.stringify(result));
    }

    if (result?.baseBranch === sourceBranch) {
      pass(`resolveIfEnabled returned baseBranch = '${sourceBranch}'`);
    } else {
      fail(`Expected baseBranch '${sourceBranch}', got '${result?.baseBranch ?? 'undefined'}'`);
    }

    console.log(chalk.bold.cyan('\nTest 2: ReviewerAgent.buildFigmaSkillHint produces correct Skill(...) string'));

    if (result) {
      const hintFn = (reviewerAgent as unknown as Record<string, unknown>)['buildFigmaSkillHint'] as (r: typeof result) => string | undefined;
      const hint = hintFn(result);
      const expected = `Skill('figma-design-check', '${figmaLinks[0]} ${sourceBranch}')`;
      if (hint === expected) {
        pass(`buildFigmaSkillHint = ${hint}`);
      } else {
        fail('buildFigmaSkillHint produced unexpected string', `got: ${hint}\nexpected: ${expected}`);
      }
    } else {
      fail('Skipped buildFigmaSkillHint check — result was undefined from Test 1');
    }

    console.log(chalk.bold.cyan('\nTest 3: resolveIfEnabled returns undefined when no manifest exists for the branch'));

    const noManifestResult = await figmaStageService.resolveIfEnabled({
      repoDir,
      force: true,
      artifactDir: path.join(wfHome, 'nonexistent-repo', 'jira'),
    });

    if (!noManifestResult) {
      pass('resolveIfEnabled returns undefined when no manifest found');
    } else {
      fail('Expected undefined when no manifest exists', JSON.stringify(noManifestResult));
    }
  } finally {
    (configService as unknown as Record<string, unknown>)['get'] = originalGet;
    await app.close();
    process.env.WF_HOME = origWfHome ?? undefined;
    fs.rmSync(wfHome, { recursive: true, force: true });
    fs.rmSync(repoDir, { recursive: true, force: true });
  }

  console.log(`\n${counts.passed} passed, ${counts.failed} failed`);
  if (counts.failed > 0) process.exit(1);
  console.log('\nManual smoke test passed: FigmaStageService manifest lookup and skill hint');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
