import { describe, expect, it } from 'vitest';

import { confidenceMarker, formatLocalTimeWithOffset, formatTokens } from './format.js';

describe('formatTokens', () => {
  it('formats small counts as grouped integers', () => {
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(7)).toBe('7');
    expect(formatTokens(999)).toBe('999');
    expect(formatTokens(1000)).toBe('1,000');
    expect(formatTokens(1234)).toBe('1,234');
  });

  it('switches to one-decimal k exactly at 10,000', () => {
    expect(formatTokens(9999)).toBe('9,999');
    expect(formatTokens(10000)).toBe('10.0k');
    expect(formatTokens(10049)).toBe('10.0k');
    expect(formatTokens(10050)).toBe('10.1k');
    expect(formatTokens(12400)).toBe('12.4k');
    expect(formatTokens(999_899)).toBe('999.9k');
  });

  it('promotes to M and B at the unit boundaries', () => {
    expect(formatTokens(1_000_000)).toBe('1.0M');
    expect(formatTokens(3_200_000)).toBe('3.2M');
    expect(formatTokens(999_950)).toBe('1.0M'); // rounds up past 999.9k → promoted
    expect(formatTokens(999_949_999)).toBe('999.9M');
    expect(formatTokens(1_000_000_000)).toBe('1.0B');
    expect(formatTokens(2_345_000_000_000)).toBe('2,345.0B');
  });

  it('is deterministic and rounds non-integers before formatting', () => {
    expect(formatTokens(1234.4)).toBe('1,234');
    expect(formatTokens(9999.5)).toBe('10.0k');
    expect(formatTokens(10000)).toBe(formatTokens(10000));
  });

  it('rejects negative and non-finite inputs', () => {
    expect(() => formatTokens(-1)).toThrow(/non-negative/);
    expect(() => formatTokens(Number.NaN)).toThrow(/non-negative/);
    expect(() => formatTokens(Number.POSITIVE_INFINITY)).toThrow(/non-negative/);
  });
});

describe('confidenceMarker', () => {
  it('maps confidence levels to the spec §6 markers', () => {
    expect(confidenceMarker('high')).toBe('●');
    expect(confidenceMarker('medium')).toBe('◐');
    expect(confidenceMarker('low')).toBe('○');
  });

  it('markers are single code points (rendered width 1 in the table renderer)', () => {
    for (const conf of ['high', 'medium', 'low'] as const) {
      expect([...confidenceMarker(conf)].length).toBe(1);
    }
  });
});

describe('formatLocalTimeWithOffset', () => {
  const ts = Date.UTC(2026, 0, 15, 12, 0, 0); // 2026-01-15T12:00:00Z

  it('renders UTC with a +00:00 offset', () => {
    expect(formatLocalTimeWithOffset(ts, 'UTC')).toBe('2026-01-15 12:00:00 +00:00');
  });

  it('renders a positive half-hour offset zone (Asia/Kolkata)', () => {
    expect(formatLocalTimeWithOffset(ts, 'Asia/Kolkata')).toBe('2026-01-15 17:30:00 +05:30');
  });

  it('renders a negative offset zone (America/New_York, EST in January)', () => {
    expect(formatLocalTimeWithOffset(ts, 'America/New_York')).toBe('2026-01-15 07:00:00 -05:00');
  });

  it('follows DST for the zone (America/New_York, EDT in July)', () => {
    const july = Date.UTC(2026, 6, 14, 12, 0, 0);
    expect(formatLocalTimeWithOffset(july, 'America/New_York')).toBe('2026-07-14 08:00:00 -04:00');
  });

  it('uses the system zone when no override is given, in the same shape', () => {
    expect(formatLocalTimeWithOffset(ts)).toMatch(
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} [+-]\d{2}:\d{2}$/,
    );
  });

  it('is deterministic for a fixed zone', () => {
    expect(formatLocalTimeWithOffset(ts, 'Asia/Kolkata')).toBe(
      formatLocalTimeWithOffset(ts, 'Asia/Kolkata'),
    );
  });
});
