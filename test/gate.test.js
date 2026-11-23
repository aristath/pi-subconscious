import test from 'node:test';
import assert from 'node:assert/strict';
import { Gate } from '../src/gate.js';
import { deferred } from './helpers.js';

test('foreground is admitted immediately even mid-step and blocks further steps until idle', async () => {
  const gate = new Gate();
  const release = await gate.privateStep('model', 'private-model');
  gate.update('user', { pid: 123, busy: true, file: 'synthetic', sessionId: 's' });
  assert.equal(gate.busy(), true, 'foreground registers busy without waiting for the active step');
  let entered = false;
  const next = gate.privateStep('tool', 'pending-tool').then(release => { entered = true; return release; });
  release();
  await Promise.resolve();
  assert.equal(entered, false);
  gate.update('user', { pid: 123, busy: false });
  const releaseNext = await next;
  assert.equal(entered, true); releaseNext();
});

test('multiple foreground sessions must all be idle before private work resumes', async () => {
  const gate = new Gate();
  gate.update('one', { pid: 123, busy: true }); gate.update('two', { pid: 124, busy: true });
  let entered = false;
  const next = gate.privateStep('model', 'private').then(release => { entered = true; return release; });
  gate.remove('one'); await Promise.resolve(); assert.equal(entered, false);
  gate.remove('two'); (await next)();
  assert.equal(entered, true);
});

test('pause lets an active step settle and retains waiting work until resumed', async () => {
  let paused = false;
  const gate = new Gate(() => paused);
  const release = await gate.privateStep('tool', 'active');
  paused = true;
  let resumed = false;
  const next = gate.privateStep('model', 'waiting').then(release => { resumed = true; return release; });
  release(); await Promise.resolve(); assert.equal(resumed, false);
  paused = false; gate.wake(); (await next)(); assert.equal(resumed, true);
});

test('live hosts keep their busy claim; crashed hosts are pruned at admission', async () => {
  const gate = new Gate(() => false, pid => pid === 1);
  gate.update('live', { pid: 1, busy: true }); gate.update('dead', { pid: 2, busy: true });
  assert.equal(gate.busy(), true);
  assert.equal(gate.clients.has('live'), true); assert.equal(gate.clients.has('dead'), false);
  gate.remove('live'); assert.equal(gate.busy(), false);
});

test('private work is serialized and shutdown wakes waiting boundaries', async () => {
  const gate = new Gate();
  const release = await gate.privateStep('model', 'first');
  const entered = deferred();
  const second = gate.privateStep('tool', 'second').then(release => { entered.resolve(); return release; });
  release(); const releaseSecond = await second; await entered.promise;
  assert.equal(gate.active.id, 'second');
  const rejected = assert.rejects(gate.privateStep('model', 'third'), /stopping/);
  gate.stop(); releaseSecond(); await rejected;
});

test('background jobs stay FIFO across turns, and a failed or cancelled job releases its place', async () => {
  const gate = new Gate(), firstTurn = deferred(), finish = deferred(), order = [];
  const first = gate.background('first', async () => {
    order.push('first'); const release = await gate.privateStep('turn', 'first');
    firstTurn.resolve(); await finish.promise; release(); throw new Error('Controlled failure');
  });
  const failed = assert.rejects(first, /Controlled failure/);
  await firstTurn.promise;
  const controller = new AbortController();
  const cancelled = assert.rejects(gate.background('cancelled', () => assert.fail('Cancelled job ran'), controller.signal), /stopping/);
  const second = gate.background('second', async () => { order.push('second'); (await gate.privateStep('turn', 'second'))(); });
  controller.abort(); await cancelled;
  assert.deepEqual(order, ['first']); finish.resolve(); await failed; await second;
  assert.deepEqual(order, ['first', 'second']); assert.equal(gate.active, null); assert.equal(gate.jobs.length, 0);
});
