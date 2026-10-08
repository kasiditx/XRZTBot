import { describeInteractionError } from '../../src/infrastructure/discord/interaction-error.js';

describe('safe interaction diagnostics', () => {
  it('keeps error codes and code frames without recording API tokens, evidence or user input', () => {
    const error = Object.assign(new Error('private input'), {
      code: 10062, status: 404, url: '/interactions/id/private-token', requestBody: { evidence: 'private-photo' },
      stack: 'Error: private input\n    at handleButton (/app/handler.js:10:1)',
    });
    const diagnostic = describeInteractionError(error);
    expect(diagnostic).toEqual({ name: 'Error', code: 10062, status: 404, stack: '    at handleButton (/app/handler.js:10:1)' });
    expect(JSON.stringify(diagnostic)).not.toContain('private');
  });

  it('extracts a database cause code without recording SQL parameters', () => {
    const error = new Error('Failed SQL query and parameters', { cause: { code: '23505', parameters: ['private'] } });
    expect(describeInteractionError(error).code).toBe('23505');
    expect(JSON.stringify(describeInteractionError(error))).not.toContain('parameters');
  });
});
