import { describe, expect, it } from 'vitest';

import { classifyFailure, isRateLimited, readErrorBody } from '../src/errors.js';

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
    const failure = classifyFailure(LABEL, 403, text);
    expect(failure.code).toBe('E_GOOGLE_CONFIG');
    expect(failure.message).toContain('the API is not enabled');
    expect(failure.message).not.toContain('scopes');
  });

  it('reads the scope signature second', () => {
    const text = googleBody(403, 'Request had insufficient authentication scopes.', {
      status: 'PERMISSION_DENIED',
      details: ['ACCESS_TOKEN_SCOPE_INSUFFICIENT'],
    });
    const failure = classifyFailure(LABEL, 403, text);
    expect(failure.code).toBe('E_GOOGLE_AUTH');
    expect(failure.message).toContain("the token's scopes do not cover this call");
  });

  it('tells the person to share a missing or forbidden file with the signed-in account', () => {
    for (const status of [403, 404]) {
      const failure = classifyFailure(
        LABEL,
        status,
        googleBody(status, 'The caller does not have permission', {
          status: 'PERMISSION_DENIED',
        }),
      );
      expect(failure.code).toBe(status === 404 ? 'E_GOOGLE_HTTP' : 'E_GOOGLE_AUTH');
      expect(failure.message).toContain(
        'is not shared with the Google account signed in on the plugins screen',
      );
    }
  });

  it("names the OAuth client's Cloud project when an API is disabled", () => {
    const text = googleBody(403, 'Google Drive API has not been used in project 123.', {
      status: 'PERMISSION_DENIED',
      details: ['SERVICE_DISABLED'],
    });
    expect(classifyFailure(LABEL, 403, text).message).toContain(
      'the Cloud project of the OAuth client',
    );
  });

  it('names no cause for a 401 or 403 no rule matches', () => {
    for (const status of [401, 403]) {
      const failure = classifyFailure(LABEL, status, 'denied');
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
