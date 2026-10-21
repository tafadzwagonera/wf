import { ValidationError } from '../errors/app.error';
import { buildSessionFileName, stripSessionDatePrefix } from './session-file-name';

const SESSION_ID = '11111111-1111-1111-1111-111111111111';
const CREATED_AT = '2026-10-06T10:00:00.000Z';

describe('session file names', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('building a file name from session state', () => {
    it('prefixes a bare ticket key with the createdAt date', () => {
      expect(buildSessionFileName({ ticketKey: 'WBP-417', sessionId: SESSION_ID, createdAt: CREATED_AT }))
        .toBe(`2026-10-06-WBP-417-${SESSION_ID}.json`);
    });

    it('does not double-prefix an already-dated custom stem', () => {
      expect(buildSessionFileName({ ticketKey: '2026-10-05-my-plan', sessionId: SESSION_ID, createdAt: CREATED_AT }))
        .toBe(`2026-10-05-my-plan-${SESSION_ID}.json`);
    });

    it('prefixes an undated custom stem', () => {
      expect(buildSessionFileName({ ticketKey: 'my-plan', sessionId: SESSION_ID, createdAt: CREATED_AT }))
        .toBe(`2026-10-06-my-plan-${SESSION_ID}.json`);
    });

    it('throws ValidationError for an invalid createdAt with an undated key', () => {
      expect(() => buildSessionFileName({ ticketKey: 'WBP-417', sessionId: SESSION_ID, createdAt: 'nope' }))
        .toThrow(ValidationError);
    });
  });

  describe('stripping the date prefix', () => {
    it('strips exactly one leading date', () => {
      expect(stripSessionDatePrefix('2026-10-06-2026-10-05-plan.json')).toBe('2026-10-05-plan.json');
    });

    it('leaves undated names unchanged', () => {
      expect(stripSessionDatePrefix('WBP-417-abc.json')).toBe('WBP-417-abc.json');
    });
  });
});
