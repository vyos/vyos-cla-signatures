const { test } = require('node:test');
const assert = require('node:assert');
const C = require('../src/constants');

test('constants are byte-exact', () => {
  assert.strictEqual(C.SIGN_PHRASE, 'I have read the CLA Document and I hereby sign the CLA');
  assert.strictEqual(C.RECHECK_PHRASE, 'recheck');
  assert.strictEqual(C.MARKER, '<!-- vyos-cla-action -->');
  assert.strictEqual(C.BOT_LOGIN, 'github-actions[bot]');
  assert.strictEqual(C.LEGACY_NEEDLE, 'CLA Assistant Lite');
});
