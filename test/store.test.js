import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { loadConfig } from '../src/config.js';
import { fixture } from './helpers.js';

test('each reflection has its own source and can finish silently or return once', t => {
  const { config } = fixture(t);
  const store = new Store(config);
  const source = { file: '/synthetic/source.jsonl', sessionId: 'synthetic-session', callId: 'synthetic-call', entryId: 'synthetic-entry', context: [] };
  const a = store.reflect('A synthetic thought.', source, 'reflect-a');
  const b = store.reflect('Another synthetic thought.', { ...source, callId: 'other-call' }, 'reflect-b');
  assert.notEqual(a.id, b.id);
  assert.equal(store.reflect('Duplicate', source, 'reflect-a').id, a.id);
  store.finish(a.id, undefined, 'finish-a');
  assert.equal(store.row(a.id).status, 'finished');
  assert.equal(store.state.deliveries[a.id], undefined);
  store.finish(b.id, 'A selected fictional reflection.', 'return-b');
  assert.equal(store.state.deliveries[b.id].content, 'A selected fictional reflection.');
  assert.equal(store.state.deliveries[b.id].status, 'pending');
  assert.equal(Object.keys(store.state.deliveries).length, 1);
  assert.equal(new Store(config).row(b.id).status, 'returned');
});

test('an invalid mutation does not lose previously accepted state', t => {
  const { config } = fixture(t);
  const store = new Store(config);
  store.change(state => { state.paused = true; });
  assert.throws(() => store.change(state => { state.paused = false; throw new Error('synthetic failure'); }), /synthetic failure/);
  assert.equal(store.state.paused, true);
  assert.equal(new Store(config).state.paused, true);
});

test('error-retry configuration requires a nonnegative finite number', t => {
  const f = fixture(t);
  assert.throws(() => f.writeConfig({ errorRetryMs: -1 }), /nonnegative/);
  assert.throws(() => f.writeConfig({ errorRetryMs: 'soon' }), /nonnegative/);
});
