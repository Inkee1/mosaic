import test from 'node:test';
import assert from 'node:assert/strict';
import { isAllowedPopupUrl } from '../popup-origin.mjs';

test('transient login URLs support OAuth state while rejecting executable, local and credential URLs', () => {
  for (const url of ['about:blank', 'https://example.com/login?state=' + 'x'.repeat(4000), 'http://127.0.0.1:3000/callback'])
    assert.equal(isAllowedPopupUrl(url), true);
  for (const url of ['javascript:alert(1)', 'file:///C:/secret', 'data:text/html,hi', 'https://user:secret@example.com', 'https://', null, 'https://example.com/' + 'x'.repeat(65536)])
    assert.equal(isAllowedPopupUrl(url), false);
});
