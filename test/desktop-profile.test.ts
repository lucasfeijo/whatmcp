import test from 'node:test';
import assert from 'node:assert/strict';
import { createProfileSession } from '../desktop/src/profile-session.ts';
import type { Overview } from '../desktop/src/types.ts';

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const overview = (profile: string) => ({ profile } as Overview);
function fixture() {
  let profile = 'old', error = 'Select an existing WhatMCP folder containing config.json';
  const published: string[] = [], events: string[] = [];
  let oldRequest: ReturnType<typeof deferred<Overview>> | undefined;
  let switchRequest: ReturnType<typeof deferred<Overview>> | undefined;
  const session = createProfileSession({
    call: async <T>(method: string) => (method === 'overview' ? oldRequest?.promise ?? overview(profile) : []) as T,
    switchProfile: async () => { const result = switchRequest ? await switchRequest.promise : overview('new'); profile = result.profile; return result; },
    publish: status => { published.push(status.profile); events.push(`publish:${status.profile}`); },
    changed: () => events.push('changed'), clearError: () => { error = ''; events.push('clear'); },
    onError: message => { error = message; },
  });
  return { session, published, events, error: () => error, old: (request: typeof oldRequest) => { oldRequest = request; }, switching: (request: typeof switchRequest) => { switchRequest = request; } };
}
test('successful selection clears the previous warning and publishes returned profile immediately', async () => {
  const f = fixture(); await f.session.switchProfile('existing', ' ~/.whatmcp ');
  assert.equal(f.error(), ''); assert.deepEqual(f.events.slice(0, 3), ['clear', 'changed', 'publish:new']);
});
test('an overview started before switching cannot restore the old profile', async () => {
  const f = fixture(), old = deferred<Overview>(); f.old(old);
  const poll = f.session.refresh(); f.old(undefined);
  await f.session.switchProfile('existing', '/fixture/new'); old.resolve(overview('old')); await poll;
  assert.ok(f.published.length > 0); assert.ok(f.published.every(profile => profile === 'new'));
});
test('a stale polling failure cannot restore a warning after successful selection', async () => {
  const f = fixture(), old = deferred<Overview>(); f.old(old);
  const poll = f.session.refresh(); f.old(undefined);
  await f.session.switchProfile('existing', '/fixture/new'); old.reject(new Error('old runtime closed')); await poll;
  assert.equal(f.error(), '');
});
test('failed selection preserves the current profile and polling can resume', async () => {
  const f = fixture(), change = deferred<Overview>(); f.switching(change);
  const attempt = f.session.switchProfile('existing', '/missing'); change.reject(new Error('invalid folder'));
  await assert.rejects(attempt, /invalid folder/); assert.deepEqual(f.published, []);
  await f.session.refresh(); assert.deepEqual(f.published, ['old']); assert.notEqual(f.error(), '');
});
test('polling is paused and duplicate selections are ignored while switching', async () => {
  const f = fixture(), change = deferred<Overview>(); f.switching(change);
  const attempt = f.session.switchProfile('existing', '/fixture/new');
  await f.session.refresh(); await f.session.switchProfile('demo'); assert.deepEqual(f.published, []);
  change.resolve(overview('new')); await attempt; assert.deepEqual(f.published, ['new', 'new']);
});
