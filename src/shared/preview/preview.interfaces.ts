export interface ApiCallPreview {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  endpoint: string;
  platform: string;
  description: string;
  estimatedResponse?: string;
  payloadPreviewLines?: string[];
}

export interface FileWritePreview {
  filePath: string;
  operation: 'create' | 'overwrite';
  sizeEstimate: string;
  format?: string;
  contentPreview?: string;
}

export interface FileReadPreview {
  filePath: string;
  exists: boolean;
  sizeInKb?: string;
}

export interface GitOperationPreview {
  operation: 'commit' | 'branch' | 'checkout' | 'push';
  description: string;
  fileCount?: number;
  message?: string;
}

export interface DryRunSummary {
  apiCallCount: number;
  fileCreatedCount: number;
  fileModifiedCount: number;
  gitOperationCount: number;
  terminalOutputLines?: string[];
}
