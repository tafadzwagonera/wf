import { createHash } from 'crypto';
import * as path from 'path';

export interface GeneratedTicketSourceManifest {
  artifactPath: string;
  createdAt: string;
  format: string;
  hash: string;
  trackerName: string;
  sources: string[];
}

const GENERATED_TICKET_ARTIFACT_SUFFIX = 'ticket-description';
const GENERATED_TICKET_MANIFEST_EXTENSION = '.sources.json';

const toDateStamp = (date: Date): string => date.toISOString().split('T')[0];

const normalizeFormat = (format: string): string =>
  format.trim().toLowerCase() === 'md' ? 'md' : format.trim().toLowerCase();

/**
 * Build the deterministic source hash used in generated ticket filenames.
 *
 * @param sources - Ordered raw CLI source arguments
 * @returns Short lowercase SHA-256 token
 */
export const hashGeneratedTicketSources = (sources: string[]): string => {
  const hash = createHash('sha256');

  for (const source of sources) {
    hash.update(source);
  }

  return hash.digest('hex').slice(0, 8);
};

/**
 * Build the basename stem for a generated ticket artifact.
 *
 * @param createdAt - Date used for the filename prefix
 * @param sources - Ordered raw CLI source arguments
 * @returns Filename stem without extension
 */
export const buildGeneratedTicketArtifactStem = (
  createdAt: Date,
  sources: string[],
): string =>
  `${toDateStamp(createdAt)}-${hashGeneratedTicketSources(sources)}-${GENERATED_TICKET_ARTIFACT_SUFFIX}`;

/**
 * Build the full generated ticket artifact filename.
 *
 * @param createdAt - Date used for the filename prefix
 * @param sources - Ordered raw CLI source arguments
 * @param format - Requested output format
 * @returns Filename including extension
 */
export const buildGeneratedTicketArtifactFilename = (
  createdAt: Date,
  sources: string[],
  format: string,
): string =>
  `${buildGeneratedTicketArtifactStem(createdAt, sources)}.${normalizeFormat(format)}`;

/**
 * Build the sidecar manifest filename for a generated ticket artifact.
 *
 * @param artifactFilename - Generated ticket artifact filename
 * @returns Manifest filename alongside the artifact
 */
export const buildGeneratedTicketManifestFilename = (
  artifactFilename: string,
): string => {
  const extensionlessArtifact = artifactFilename.replace(/\.[^.]+$/, '');
  return `${extensionlessArtifact}${GENERATED_TICKET_MANIFEST_EXTENSION}`;
};

/**
 * Build the manifest payload stored next to each generated ticket artifact.
 *
 * @param artifactPath - Absolute artifact path
 * @param trackerName - Artifact platform namespace
 * @param format - Serialized artifact format
 * @param sources - Ordered raw CLI source arguments
 * @param createdAt - Creation timestamp
 * @returns Source manifest used for reversible lookup
 */
export const buildGeneratedTicketSourceManifest = (
  artifactPath: string,
  trackerName: string,
  format: string,
  sources: string[],
  createdAt: Date,
): GeneratedTicketSourceManifest => ({
  artifactPath,
  createdAt: createdAt.toISOString(),
  format: normalizeFormat(format),
  hash: hashGeneratedTicketSources(sources),
  trackerName,
  sources,
});

/**
 * Determine whether a lookup token matches a stored generated ticket hash.
 *
 * @param token - Token or partial hash entered by the user
 * @param hash - Stored hash from a manifest
 * @returns True when the token identifies the hash
 */
export const matchesGeneratedTicketToken = (
  token: string,
  hash: string,
): boolean => {
  const normalizedToken = token.trim().toLowerCase();
  const normalizedHash = hash.trim().toLowerCase();

  return (
    normalizedHash === normalizedToken ||
    normalizedHash.startsWith(normalizedToken)
  );
};

/**
 * Compute the default sidecar manifest path for a generated ticket artifact.
 *
 * @param artifactPath - Absolute artifact path
 * @returns Sidecar manifest path with the `.sources.json` extension
 */
export const buildGeneratedTicketManifestPath = (
  artifactPath: string,
): string =>
  path.join(
    path.dirname(artifactPath),
    buildGeneratedTicketManifestFilename(path.basename(artifactPath)),
  );
