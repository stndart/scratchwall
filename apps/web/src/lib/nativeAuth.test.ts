import { describe, expect, it } from 'vitest';
import { nativeCallbackCode } from './nativeAuth';

describe('nativeCallbackCode', () => {
  it('accepts both host and empty-host callback URLs', () => {
    expect(nativeCallbackCode('scratchwall://auth/callback?code=abc')).toBe('abc');
    expect(nativeCallbackCode('scratchwall:///auth/callback?code=abc')).toBe('abc');
  });

  it('ignores unrelated schemes and paths', () => {
    expect(nativeCallbackCode('https://scratchwall.example.com/auth/callback?code=abc')).toBeUndefined();
    expect(nativeCallbackCode('scratchwall://auth/other?code=abc')).toBeUndefined();
  });
});
