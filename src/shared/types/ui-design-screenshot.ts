import type { StageProgressCallback } from './agent.types';

export interface UiDesignScreenshot {
  path: string;
  mediaType: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/tiff' | 'image/svg+xml';
  base64: string;
}

export interface UiDesignScreenshotsResult {
  screenshots: UiDesignScreenshot[];
  paths: string[];
}

export interface UiDesignScreenshotsStageOptions {
  artifactPath: string;
  onProgress?: StageProgressCallback;
}
