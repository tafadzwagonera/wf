import * as fs from 'node:fs';
import * as path from 'node:path';
import { Injectable } from '@nestjs/common';
import { appendToLogFile } from '../shared/logger/log-file-writer';
import { readUiDesignScreenshotsFromPlanArtifact } from '../shared/utils/plan-artifact';
import type { UiDesignScreenshot, UiDesignScreenshotsResult, UiDesignScreenshotsStageOptions } from '../shared/types/ui-design-screenshot';

const MEDIA_TYPES: Record<string, UiDesignScreenshot['mediaType']> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.svg': 'image/svg+xml',
};

const LOG_CONTEXT = 'ui-design-screenshots';

@Injectable()
export class UiDesignScreenshotsStageService {
  private encodeFile(p: string): UiDesignScreenshot {
    const buf = fs.readFileSync(p);
    const ext = path.extname(p).toLowerCase();
    const mediaType = MEDIA_TYPES[ext] ?? 'image/png';
    return { path: p, mediaType, base64: buf.toString('base64') };
  }

  encodeFromPaths(paths: string[]): UiDesignScreenshotsResult {
    const screenshots: UiDesignScreenshot[] = [];
    for (const p of paths) {
      if (!fs.existsSync(p)) {
        appendToLogFile('WARN', `ui-design-screenshots: file not found at encode time — ${p}`, LOG_CONTEXT);
        continue;
      }
      screenshots.push(this.encodeFile(p));
    }
    return { screenshots, paths: screenshots.map(s => s.path) };
  }

  async resolveIfEnabled(options: UiDesignScreenshotsStageOptions): Promise<UiDesignScreenshotsResult | undefined> {
    const paths = readUiDesignScreenshotsFromPlanArtifact(options.artifactPath);
    if (!paths) return undefined;
    return this.encodeFromPaths(paths);
  }
}
