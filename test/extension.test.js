import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import extension from '../src/extension.js';
import { startService } from '../src/service.js';
import { originContext } from '../src/native-operations.js';
import { RETURN_TYPE } from '../src/private-extension.js';
import { TaskScheduler } from '../src/tasks.js';
import { runTask } from '../src/task-runner.js';
import { fixture, foreground, output, call, deferred, assistantMessage, until } from './helpers.js';

async function closeSession(session) {
  await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
  session.dispose();
}

test('the real foreground extension injects selected context once, never auto-prompts, and does not misroute it', async t => {
  const f = fixture(t, { initialRestMs: 60000 });
  const service = await startService(f.config, { schedule: false });
  const seen = []; let requests = 0;
  const source = await foreground(f.config, extension, ({ context }) => { requests++; seen.push(context.messages); return output('A synthetic foreground response.'); });
  const other = await foreground(f.config, extension, () => output('Another synthetic response.'));
  t.after(async () => { await closeSession(source); await closeSession(other); await service.close(); });
  const manager = source.sessionManager;
  manager.appendMessage({ ...assistantMessage(''), content: [call('subconscious_reflect', { content: 'A fictional originating thought.' }, 'original-call')], stopReason: 'toolUse' });
  manager.appendMessage({ role: 'toolResult', toolCallId: 'original-call', toolName: 'subconscious_reflect', content: [{ type: 'text', text: 'Synthetic accepted receipt.' }], isError: false, timestamp: Date.now() });
  const row = service.coordinator.store.reflect('A fictional originating thought.', originContext(manager, 'original-call'), 'reflection');
  service.coordinator.store.finish(row.id, 'Only this selected fictional insight.', 'return');
  assert.equal(requests, 0, 'Returning a reflection must not trigger inference');
  await other.prompt('A fictional question in another session.');
  assert.equal(service.coordinator.store.state.deliveries[row.id].status, 'pending');
  await source.prompt('Continue the fictional conversation.');
  assert.equal(requests, 1);
  const returned = seen[0].find(message => typeof message.content === 'string' && message.content.includes('Only this selected fictional insight.') || Array.isArray(message.content) && message.content.some(part => part.type === 'text' && part.text.includes('Only this selected fictional insight.')));
  assert.ok(returned);
  const entries = source.sessionManager.getBranch().filter(entry => entry.type === 'custom_message' && entry.customType === RETURN_TYPE);
  assert.equal(entries.length, 1); assert.equal(entries[0].display, false);
  assert.deepEqual(entries[0].details.deliveryIds, [row.id]);
  assert.equal(service.coordinator.store.state.deliveries[row.id].status, 'delivered');
  await source.prompt('One more fictional question.');
  assert.equal(source.sessionManager.getBranch().filter(entry => entry.type === 'custom_message' && entry.customType === RETURN_TYPE).length, 1);
  assert.equal(service.coordinator.gate.busy(), false);
});

test('the foreground tool creates an actual receipt tied to its persisted invocation', async t => {
  const f = fixture(t, { initialRestMs: 60000 });
  const service = await startService(f.config, { schedule: false });
  let request = 0;
  const session = await foreground(f.config, extension, () => ++request === 1 ? output([call('subconscious_reflect', { content: 'A synthetic thought to explore.' }, 'real-reflection-call')]) : output('A synthetic acknowledgement.'));
  t.after(async () => { await closeSession(session); await service.close(); });
  await session.prompt('Consider a fictional subject.');
  const reflections = service.coordinator.store.list().filter(row => row.kind === 'reflection' && row.id !== 'sample-reflection');
  assert.equal(reflections.length, 1);
  assert.equal(reflections[0].content, 'A synthetic thought to explore.');
  assert.equal(reflections[0].source.sessionId, session.sessionManager.getSessionId());
  assert.equal(reflections[0].source.callId, 'real-reflection-call');
  const result = session.messages.find(message => message.role === 'toolResult' && message.toolCallId === 'real-reflection-call');
  assert.equal(result.details.id, reflections[0].id);
});

test('a foreground SDK request proceeds during an active private step and unregisters on shutdown', async t => {
  const f = fixture(t, { initialRestMs: 60000 });
  const service = await startService(f.config, { schedule: false });
  const entered = deferred();
  const session = await foreground(f.config, extension, () => { entered.resolve(); return output('Synthetic reply.'); });
  t.after(async () => { await closeSession(session); await service.close(); });
  const release = await service.coordinator.gate.privateStep('model', 'synthetic-active-generation');
  const prompt = session.prompt('A synthetic foreground question.');
  await entered.promise; // admitted without waiting for the in-flight private step
  assert.equal(service.coordinator.gate.busy(), true);
  release(); await prompt;
  assert.equal(service.coordinator.gate.busy(), false);
});

test('Pi-native commands inspect and pause without adding a user message or calling a model', async t => {
  const f = fixture(t, { initialRestMs: 60000 });
  const service = await startService(f.config, { schedule: false });
  let requests = 0;
  const session = await foreground(f.config, extension, () => { requests++; return output(); });
  t.after(async () => { await closeSession(session); await service.close(); });
  await session.prompt('/subconscious pause');
  assert.equal(service.coordinator.store.state.paused, true);
  await session.prompt('/subconscious list');
  const inspections = session.sessionManager.getEntries().filter(entry => entry.type === 'custom_message' && entry.customType === 'pi-subconscious:inspection');
  assert.equal(inspections.length, 2);
  assert.equal(inspections.every(entry => entry.display), true);
  assert.equal(requests, 0);
  await session.prompt('/subconscious resume');
  assert.equal(service.coordinator.store.state.paused, false);
});

test('the run_task tool returns a queued receipt before chat finishes, then runs the owning task', async t => {
  const finish = deferred(), replying = deferred();
  let session, service, scheduler;
  t.after(async () => {
    finish.resolve();
    if (session) { await session.abort(); await closeSession(session); }
    await service?.close(); await scheduler?.close();
  });
  const f = fixture(t, { initiallyPaused: true });
  await mkdir(join(f.workspace, 'tasks'));
  await writeFile(join(f.workspace, 'tasks/example.js'), '/**\n * @every 6 months\n * @quiet_window 1h\n * @mode deterministic\n */\nexport default async ({user}) => { const {writeFile} = await import("node:fs/promises"); await writeFile("tasks/result.txt", user); };');
  scheduler = new TaskScheduler({ users: async () => [{ id: 'owner', folder: f.workspace }],
    prepare: async () => ({ workspace: f.workspace, agentDir: f.agentDir }), execute: runTask });
  await scheduler.pending();
  const scheduled = scheduler.state(f.workspace).value.tasks['example.js'].nextRun;
  service = await startService(f.config, { schedule: false, gate: scheduler.gate, enqueueTask: (name, key) => scheduler.request('owner', name, key) });
  let requests = 0;
  session = await foreground(f.config, extension, async () => {
    if (++requests === 1) return output([call('run_task', { task: 'example.js' }, 'manual-call')]);
    replying.resolve(); await finish.promise; return output('The task is queued.');
  });
  const chat = session.prompt('Run the example task.'); await replying.promise;
  const receipt = session.messages.find(message => message.role === 'toolResult' && message.toolCallId === 'manual-call');
  assert.equal(receipt.details.status, 'queued'); assert.equal(receipt.details.task, 'example.js');
  assert.equal(await scheduler.tick(), false, 'task started before its requesting chat finished');
  finish.resolve(); await chat;
  await until(() => !scheduler.running);
  assert.equal(await readFile(join(f.workspace, 'tasks/result.txt'), 'utf8'), 'owner');
  assert.equal(scheduler.state(f.workspace).value.tasks['example.js'].nextRun, scheduled);
});
