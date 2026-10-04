import { expect, it } from 'vitest';
import { formatDate, formatDateTime } from '../../src/lib/format';

it('uses the selected language for calendar dates and times, with honest invalid-date output', () => {
  expect(formatDate('2026-10-03', 'de')).toMatch(/3\. Okt\. 2026/);
  expect(formatDate('2026-10-03', 'en')).toBe('Oct 3, 2026');
  expect(formatDateTime('2026-10-03T17:00:00Z', 'de')).not.toMatch(/Oct|AM|PM/);
  expect(formatDate('invalid', 'de')).toBe('—');
  expect(formatDateTime(undefined, 'de')).toBe('—');
});
