import { describe, expect, it } from 'vitest';

import { classifyFailure, isRateLimited, readErrorBody } from '../src/errors.js';
import { CLIENT_EMAIL } from './google.js';

const LABEL = 'GET sheets.googleapis.com/v4/spreadsheets/x';

function googleBody(
  status: number,
  message: string,
  extra: { status?: string; reasons?: string[]; details?: string[] } = {},
): string {
  return JSON.stringify({
    error: {
      code: status,
      message,
      ...(extra.status === undefined ? {} : { status: extra.status }),
      errors: (extra.reasons ?? []).map((reason) => ({ domain: 'global', reason })),
      details: (extra.details ?? []).map((reason) => ({
        '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
        reason,
      })),
    },
  });
}

describe('classifyFailure', () => {
  it('reads a disabled API first, even when the answer carries a scope signature too', () => {
    const text = googleBody(
      403,
      'Google Sheets API has not been used in project 123 before or it is disabled.',
      {
        status: 'PERMISSION_DENIED',
        details: ['SERVICE_DISABLED', 'ACCESS_TOKEN_SCOPE_INSUFFICIENT'],
      },
    );
    const failure = classifyFailure(LABEL, 403, text, CLIENT_EMAIL);
    expect(failure.code).toBe('E_GOOGLE_CONFIG');
    expect(failure.message).toContain('the API is not enabled');
    expect(failure.message).not.toContain('scopes');
  });

  it('reads the scope signature second', () => {
    const text = googleBody(403, 'Request had insufficient authentication scopes.', {
      status: 'PERMISSION_DENIED',
      details: ['ACCESS_TOKEN_SCOPE_INSUFFICIENT'],
    });
    const failure = classifyFailure(LABEL, 403, text, CLIENT_EMAIL);
    expect(failure.code).toBe('E_GOOGLE_AUTH');
    expect(failure.message).toContain("the token's scopes do not cover this call");
  });

  it('asks to share a missing or forbidden file with the service account', () => {
    const missing = classifyFailure(
      LABEL,
      404,
      googleBody(404, 'Requested entity was not found.'),
      CLIENT_EMAIL,
    );
    expect(missing.code).toBe('E_GOOGLE_HTTP');
    expect(missing.message).toContain(`share it with ${CLIENT_EMAIL}`);

    const forbidden = classifyFailure(
      LABEL,
      403,
      googleBody(403, 'The caller does not have permission', { status: 'PERMISSION_DENIED' }),
      CLIENT_EMAIL,
    );
    expect(forbidden.code).toBe('E_GOOGLE_AUTH');
    expect(forbidden.message).toContain(`share it with ${CLIENT_EMAIL}`);
  });

  it('names no cause for a 401 or 403 no rule matches', () => {
    for (const status of [401, 403]) {
      const failure = classifyFailure(LABEL, status, 'denied', CLIENT_EMAIL);
      expect(failure.code).toBe('E_GOOGLE_AUTH');
      expect(failure.message).toContain('unknown cause');
      expect(failure.message).not.toContain('scope');
      expect(failure.message).not.toContain('share');
    }
  });

  it("quotes Google's own message for anything else, shortened", () => {
    const failure = classifyFailure(
      LABEL,
      400,
      googleBody(400, `Unable to parse range: ${'x'.repeat(400)}`),
      CLIENT_EMAIL,
    );
    expect(failure).toMatchObject({ code: 'E_GOOGLE_HTTP', status: 400 });
    expect(failure.message).toContain('Google said: Unable to parse range');
    expect(failure.message.length).toBeLessThan(450);
  });
});

describe('isRateLimited', () => {
  it("is a 429, or Drive's rate-limit 403, and no other 403", () => {
    expect(isRateLimited(429, readErrorBody(''))).toBe(true);
    for (const reason of ['rateLimitExceeded', 'userRateLimitExceeded']) {
      expect(
        isRateLimited(403, readErrorBody(googleBody(403, 'slow down', { reasons: [reason] }))),
      ).toBe(true);
    }
    expect(
      isRateLimited(403, readErrorBody(googleBody(403, 'no', { reasons: ['forbidden'] }))),
    ).toBe(false);
    expect(
      isRateLimited(500, readErrorBody(googleBody(500, 'x', { reasons: ['rateLimitExceeded'] }))),
    ).toBe(false);
  });
});
