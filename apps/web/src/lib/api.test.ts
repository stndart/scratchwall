// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import { silentLoginUrl } from './api';

describe('silent login url', () => {
  it('asks the server for a prompt=none web login', () => {
    expect(silentLoginUrl()).toContain('/api/v1/auth/login?mode=web&silent=1');
  });
});
