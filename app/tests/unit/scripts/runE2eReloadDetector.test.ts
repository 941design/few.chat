import { describe, it, expect } from 'vitest';
// @ts-expect-error plain .mjs helper without types
import { isReloadOrErrorLine, createReloadDetector } from '../../../scripts/e2eReloadDetector.mjs';

describe('e2e dev-server reload detector', () => {
  it.each([
    ' ⚠ Fast Refresh had to perform a full reload due to a runtime error.',
    ' GET /groups/ 500 in 35ms',
    '\u001b[31m GET /groups 503 in 2s\u001b[0m',
    ' POST /api/x 502 in 10ms',
  ])('flags %s', (l) => expect(isReloadOrErrorLine(l)).toBe(true));

  it.each([
    ' ○ Compiling /groups ...',
    ' ✓ Compiled /groups in 1200ms (800 modules)',
    ' GET /groups 200 in 1500ms (compile: 1400ms, render: 100ms)',
    ' GET /version.json 404 in 12ms',
    ' GET /_next/static/chunks/a-5000.js 200 in 3ms',
    '[e2e] Dev server ready on http://127.0.0.1:5000',
  ])('ignores %s', (l) => expect(isReloadOrErrorLine(l)).toBe(false));

  it('handles lines split across chunks and flush', () => {
    const d = createReloadDetector();
    d.feed(' GET /a 2');
    d.feed('00 in 1ms\n GET /b 50');
    d.feed('0 in 2ms');
    expect(d.offending).toEqual([]);
    d.flush();
    expect(d.offending).toEqual(['GET /b 500 in 2ms']);
  });
});
