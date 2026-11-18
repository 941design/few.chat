import { describe, it, expect } from 'vitest';
import {
  buildImageMessageContent,
  parseImageMessageContent,
} from '@/src/lib/media/imageMessage';

describe('buildImageMessageContent', () => {
  it('returns JSON string decoding to { type:"image", version:1, caption }', () => {
    const result = buildImageMessageContent('hello world');
    const parsed = JSON.parse(result);
    expect(parsed).toEqual({ type: 'image', version: 1, caption: 'hello world' });
  });

  it('empty caption produces caption: ""', () => {
    const result = buildImageMessageContent('');
    const parsed = JSON.parse(result);
    expect(parsed.caption).toBe('');
  });
});

describe('parseImageMessageContent', () => {
  it('round-trips a non-empty caption', () => {
    const content = buildImageMessageContent('test caption');
    const parsed = parseImageMessageContent(content);
    expect(parsed).toEqual({ type: 'image', version: 1, caption: 'test caption' });
  });

  it('round-trips empty caption', () => {
    const content = buildImageMessageContent('');
    const parsed = parseImageMessageContent(content);
    expect(parsed).toEqual({ type: 'image', version: 1, caption: '' });
  });

  it('returns null for non-JSON string', () => {
    expect(parseImageMessageContent('not json')).toBeNull();
  });

  it('returns null for JSON with type !== "image"', () => {
    expect(parseImageMessageContent(JSON.stringify({ type: 'text', version: 1 }))).toBeNull();
  });

  it('returns null for JSON missing version', () => {
    expect(parseImageMessageContent(JSON.stringify({ type: 'image', caption: 'hi' }))).toBeNull();
  });

  it('returns null for unknown numeric version (forward-compat: v2 must fail closed)', () => {
    // A future sender stamping `version: 2` must not be silently coerced to v1
    // on older clients — that would mis-render a payload whose semantics we
    // do not yet understand. Strict equality on the version field is the
    // wire-format rule.
    expect(parseImageMessageContent(JSON.stringify({ type: 'image', version: 2 }))).toBeNull();
  });

  it('returns null for version: 0', () => {
    expect(parseImageMessageContent(JSON.stringify({ type: 'image', version: 0 }))).toBeNull();
  });

  it('returns null for non-numeric version (string "1")', () => {
    expect(parseImageMessageContent(JSON.stringify({ type: 'image', version: '1' }))).toBeNull();
  });

  it('returns null for poll_open discriminator (coexistence)', () => {
    const pollContent = JSON.stringify({ type: 'poll_open', pollId: 'abc' });
    expect(parseImageMessageContent(pollContent)).toBeNull();
  });

  it('returns null for poll_close discriminator (coexistence)', () => {
    const pollContent = JSON.stringify({ type: 'poll_close', pollId: 'abc' });
    expect(parseImageMessageContent(pollContent)).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(parseImageMessageContent('')).toBeNull();
  });

  it('returns null for null JSON value', () => {
    expect(parseImageMessageContent('null')).toBeNull();
  });
});
