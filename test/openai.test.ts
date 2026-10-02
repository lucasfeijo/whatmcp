import test from 'node:test';
import assert from 'node:assert/strict';
import { splitBatches } from '../src/index/openai.ts';

test('truncates emoji-heavy windows on UTF-8 boundaries before embedding', () => {
  const text = '😀'.repeat(3_000);
  const [batch] = splitBatches([text]);
  assert.equal(batch.truncated, 1);
  assert.ok(Buffer.byteLength(batch.texts[0], 'utf8') <= 8_000);
  assert.ok(!batch.texts[0].includes('\uFFFD'));
  assert.ok(text.startsWith(batch.texts[0]));
});

test('splits requests by the UTF-8 byte upper bound', () => {
  const batches = splitBatches(Array(40).fill('😀'.repeat(2_000)));
  assert.equal(batches.flatMap((batch) => batch.texts).length, 40);
  for (const batch of batches) {
    assert.ok(batch.texts.reduce((n, s) => n + Buffer.byteLength(s, 'utf8'), 0) <= 250_000);
  }
});
