import { describe, expect, it } from 'vite-plus/test';
import type {
  ControlPlaneCommandFailedDiagnostic,
  Diagnostic,
  DiagnosticByCode,
  LoginDiagnosticCode,
  LoginReauthorizationConflictDiagnostic,
} from '../src/index.ts';
import {
  createCacheCorruptDiagnostic,
  createCacheIdentifierCollisionDiagnostic,
  createControlPlaneCommandFailedDiagnostic,
  createDiagnostic,
  createIoErrorDiagnostic,
  createParseErrorDiagnostic,
  createReleaseAgeBlockedDiagnostic,
  createUnknownErrorDiagnostic,
  DiagnosticBag,
  fail,
  fromDiagnostics,
  ok,
} from '../src/index.ts';

describe('Package release age diagnostics', () => {
  const blocked = {
    packageName: 'example',
    registry: 'default',
    ranges: ['*'],
    minimumReleaseAge: '3d',
    candidates: [
      { version: '2.0.0', publishedAt: Date.parse('2026-01-02T00:00:00Z') / 1000 },
      { version: '1.5.0', publishedAt: Date.parse('2026-01-01T12:30:00Z') / 1000 },
    ],
    overrideCommand: 'uapkg add example --ignore-release-age',
  };

  it('shows which matching version reaches the cooldown first and gives the original retry command', () => {
    const diagnostic = createReleaseAgeBlockedDiagnostic(blocked, 3 * 86400);
    expect(diagnostic.message).toContain(
      'Version 1.5.0 reaches the minimum release age first, at 2026-01-04T12:30:00.000Z',
    );
    expect(diagnostic.hint).toContain('uapkg add example --ignore-release-age');
  });

  it('displays the exact Unix time when eligibility is beyond the supported date range', () => {
    const diagnostic = createReleaseAgeBlockedDiagnostic(
      { ...blocked, candidates: [{ version: '1.5.0', publishedAt: Number.MAX_SAFE_INTEGER }] },
      3 * 86400,
    );
    expect(diagnostic.message).toContain(`first, at Unix timestamp ${BigInt(Number.MAX_SAFE_INTEGER) + 259200n}.`);
  });
});

describe('Control-plane diagnostics', () => {
  it('exposes reauthorization conflicts through the login and unified diagnostic unions', () => {
    const code: LoginDiagnosticCode = 'LOGIN_REAUTHORIZATION_CONFLICT';
    const diagnostic: LoginReauthorizationConflictDiagnostic = createDiagnostic(
      code,
      'error',
      'The saved login changed while reauthorization was in progress.',
      {},
    );
    const unified: Diagnostic = diagnostic;
    const byCode: DiagnosticByCode<'LOGIN_REAUTHORIZATION_CONFLICT'> = diagnostic;

    expect(unified.code).toBe('LOGIN_REAUTHORIZATION_CONFLICT');
    expect(byCode.data).toEqual({});
  });

  it('exposes structured command failures through the unified diagnostic union', () => {
    const diagnostic: ControlPlaneCommandFailedDiagnostic = createControlPlaneCommandFailedDiagnostic(
      'The account request failed.',
      {
        operation: 'whoami',
        serverCode: 'ACCOUNT_NOT_FOUND',
        status: 404,
      },
    );
    const unified: Diagnostic = diagnostic;
    const byCode: DiagnosticByCode<'CONTROL_PLANE_COMMAND_FAILED'> = diagnostic;

    expect(unified).toEqual({
      level: 'error',
      code: 'CONTROL_PLANE_COMMAND_FAILED',
      message: 'The account request failed.',
      data: {
        operation: 'whoami',
        serverCode: 'ACCOUNT_NOT_FOUND',
        status: 404,
      },
    });
    expect(byCode.data.operation).toBe('whoami');
  });
});

describe('Registry cache diagnostics', () => {
  it('distinguishes corruption from a shortened identifier collision', () => {
    expect(createCacheCorruptDiagnostic('/cache', 'bad metadata')).toMatchObject({
      level: 'error',
      code: 'CACHE_CORRUPT',
      data: { cachePath: '/cache', reason: 'bad metadata' },
    });
    expect(createCacheIdentifierCollisionDiagnostic('/cache', 'expected', 'actual')).toMatchObject({
      level: 'error',
      code: 'CACHE_IDENTIFIER_COLLISION',
      data: {
        cachePath: '/cache',
        expectedIdentifier: 'expected',
        actualIdentifier: 'actual',
      },
    });
  });
});

describe('Result', () => {
  it('ok wraps a value', () => {
    const result = ok(42);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(42);
    }
  });

  it('fail wraps diagnostics', () => {
    const diag = createParseErrorDiagnostic('bad json');
    const result = fail([diag]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics).toHaveLength(1);
      expect(result.diagnostics[0].code).toBe('PARSE_ERROR');
    }
  });

  it('fromDiagnostics returns ok when no errors', () => {
    const result = fromDiagnostics([], 'hello');
    expect(result.ok).toBe(true);
  });

  it('fromDiagnostics returns fail when errors present', () => {
    const diag = createIoErrorDiagnostic('/tmp/x', 'ENOENT');
    const result = fromDiagnostics([diag], 'hello');
    expect(result.ok).toBe(false);
  });
});

describe('DiagnosticBag', () => {
  it('collects diagnostics and reports errors', () => {
    const bag = new DiagnosticBag();
    expect(bag.hasErrors()).toBe(false);

    bag.add(createParseErrorDiagnostic('bad'));
    expect(bag.hasErrors()).toBe(true);
    expect(bag.all()).toHaveLength(1);
  });

  it('toFailure returns ResultFail', () => {
    const bag = new DiagnosticBag();
    bag.add(createUnknownErrorDiagnostic('oops'));
    const result = bag.toFailure();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics[0].code).toBe('UNKNOWN_ERROR');
    }
  });

  it('mergeArray adds external diagnostics', () => {
    const bag = new DiagnosticBag();
    const diags = [createParseErrorDiagnostic('a'), createIoErrorDiagnostic('/x', 'b')];
    bag.mergeArray(diags);
    expect(bag.all()).toHaveLength(2);
  });
});
