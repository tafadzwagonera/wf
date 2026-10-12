import * as fs from 'node:fs';
import * as path from 'node:path';
import { INestApplicationContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { IssueImplementCommand } from '../commands/issue-implement.command';
import { normalizedAiProviderConfigSchema, wfConfigSchema } from '../shared/schemas/config.schema';
import { createTempDir } from '../shared/testing/temp-dir';
import { collectSchemaLeafPaths } from '../shared/testing/zod-schema-paths';
import { buildFixture, createFieldCases, FieldCase } from './wf-config-bootstrap.fixture';
import { initializeWfConfig, normalizeWfConfig } from './wf-config-loader';

const BOOTSTRAP_TIMEOUT_IN_MS = 30_000;

const rootDir = createTempDir('config-bootstrap');
const fieldCases = createFieldCases(rootDir);
const fixture = buildFixture(fieldCases);

const compareStrings = (left: string, right: string): number => left.localeCompare(right);

const expectationRows = (kind: FieldCase['kind']): Array<[string, string, unknown]> =>
  fieldCases
    .filter(fieldCase => fieldCase.kind === kind)
    .flatMap(fieldCase =>
      (fieldCase.expectations ?? []).map((expectation): [string, string, unknown] => [
        fieldCase.schemaPath,
        expectation.path,
        expectation.value,
      ]));

const rejectionRows = (): Array<[string, NonNullable<FieldCase['rejection']>]> =>
  fieldCases.flatMap(fieldCase =>
    fieldCase.kind === 'rejectedAtLoad' && fieldCase.rejection
      ? [[fieldCase.schemaPath, fieldCase.rejection] as [string, NonNullable<FieldCase['rejection']>]]
      : []);

const silenceConsole = (): void => {
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
};

describe('wf config bootstrap through the real AppModule', () => {
  let app: INestApplicationContext;
  let configService: ConfigService;

  beforeAll(async () => {
    silenceConsole();
    fs.writeFileSync(
      path.join(rootDir, 'wf.config.js'),
      `module.exports = ${JSON.stringify(fixture, null, 2)};`,
      'utf-8',
    );
    await initializeWfConfig(rootDir);
    app = await NestFactory.createApplicationContext(AppModule, { logger: false });
    configService = app.get(ConfigService);
  }, BOOTSTRAP_TIMEOUT_IN_MS);

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(silenceConsole);

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('covers every wfConfigSchema leaf path with a field case', () => {
    expect(collectSchemaLeafPaths(wfConfigSchema).sort(compareStrings)).toEqual(
      fieldCases.map(fieldCase => fieldCase.schemaPath).sort(compareStrings),
    );
  });

  it('builds a fixture that satisfies the public wfConfigSchema', () => {
    expect(wfConfigSchema.safeParse(fixture).success).toBe(true);
  });

  it('hands issue commands the same ConfigService instance that carries the loaded config', () => {
    const command = app.get(IssueImplementCommand);

    expect((command as unknown as { configService: ConfigService }).configService).toBe(configService);
    expect(configService.get('tracker')).toBe('github');
  });

  it('publishes ai.providers entries that satisfy normalizedAiProviderConfigSchema', () => {
    const providers = configService.get<unknown[]>('ai.providers') ?? [];

    expect(providers.map(provider => normalizedAiProviderConfigSchema.safeParse(provider).success))
      .toEqual(providers.map(() => true));
  });

  describe.each(expectationRows('roundTrip'))('round trip %s', (_schemaPath, configPath, value) => {
    it(`exposes ${configPath}`, () => {
      expect(configService.get(configPath)).toEqual(value);
    });
  });

  describe.each(expectationRows('transformed'))('transformed %s', (_schemaPath, configPath, value) => {
    it(`exposes ${configPath} in normalized form`, () => {
      expect(configService.get(configPath)).toEqual(value);
    });
  });

  describe.each(expectationRows('dropped'))('dropped %s', (_schemaPath, configPath, value) => {
    it(`does not carry ${configPath} into the runtime config`, () => {
      expect(configService.get(configPath)).toEqual(value);
    });
  });

  describe.each(rejectionRows())('rejected at load %s', (_schemaPath, rejection) => {
    it('throws when the raw config is normalized', () => {
      expect(() => normalizeWfConfig(rejection.rawConfig)).toThrow(rejection.message);
    });
  });

  it('falls back to log settings when logging is absent', () => {
    const normalized = normalizeWfConfig({ log: { level: 'debug' } });

    expect(normalized.logging.level).toBe('debug');
    expect(normalized.log.level).toBe('debug');
  });
});
