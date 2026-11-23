import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, unlink, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TaskScheduler, interval, nextRun, taskHeader } from '../src/tasks.js';
import { runTask } from '../src/task-runner.js';
import { deferred, until } from './helpers.js';

const header = (every='5 minutes', mode='deterministic', session='fresh') => `/**\n * @every ${every}\n * @mode ${mode}\n * @session ${session}\n */\n`;
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'pi-tasks-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const users = ['first', 'second'].map(id => ({ id, admin: true, folder: join(root,id) }));
  for (const user of users) await mkdir(join(user.folder,'tasks'),{recursive:true});
  let time = Date.UTC(2026,0,31,10);
  const options = { users:async()=>users, prepare:async user=>({agentDir:join(user.folder,'.pi'),taskLockDir:join(root,'lock')}), now:()=>time, report:()=>{} };
  return { root, users, options, advance:ms=>{time+=ms;}, setTime:value=>{time=value;}, task:async(user,name,source)=>writeFile(join(users[user].folder,'tasks',name),source) };
}

test('task headers support both modes, session choices, fixed intervals and calendar months', () => {
  assert.deepEqual(taskHeader(header('13h','inference','continue')), {every:{milliseconds:46800000},mode:'inference',session:'continue'});
  assert.equal(nextRun(Date.UTC(2026,0,31,10),interval('1 month')),Date.UTC(2026,1,28,10));
  assert.equal(nextRun(Date.UTC(2026,0,31,10),interval('6 months')),Date.UTC(2026,6,31,10));
  assert.equal(interval('every 5 minutes').milliseconds,300000);
  assert.throws(()=>taskHeader('/** @every 0h */'),/interval/);
  assert.throws(()=>taskHeader(header('5m','unknown')),/@mode/);
  assert.deepEqual(taskHeader('/**\n * @start_time 00:00\n * @quiet_window 30m\n * @mode inference\n */'), {start_time:'00:00',quiet_window:1800000,mode:'inference',session:'fresh'});
  assert.throws(()=>taskHeader('/**\n * @start_time 24:00\n * @mode inference\n */'), /HH:mm/);
  assert.equal(taskHeader(header()).quiet_window, undefined);
  assert.equal(taskHeader(header('5m','inference').replace('@mode inference','@mode inference\n * @model example/models/chat')).model,'example/models/chat');
  assert.throws(()=>taskHeader(header('5m','inference').replace('@mode inference','@mode inference\n * @model incomplete')),/@model/);
  assert.equal(taskHeader(header('5m','inference').replace('@mode inference','@mode inference\n * @soul none')).soul,'none');
  assert.equal(taskHeader(header()).soul,undefined);
  assert.throws(()=>taskHeader(header('5m','inference').replace('@mode inference','@mode inference\n * @soul unknown')),/@soul/);
  assert.equal(taskHeader(header('5m','inference').replace('@mode inference','@mode inference\n * @thinking low')).thinking,'low');
  assert.equal(taskHeader(header()).thinking,undefined);
  assert.throws(()=>taskHeader(header('5m','inference').replace('@mode inference','@mode inference\n * @thinking turbo')),/@thinking/);
  assert.equal(taskHeader(header('5m','inference').replace('@mode inference','@mode inference\n * @tools read,+presence_read')).tools,'read,+presence_read');
  assert.equal(taskHeader(header('5m','inference').replace('@mode inference','@mode inference\n * @exclude_tools bash,write')).exclude_tools,'bash,write');
  assert.equal(taskHeader(header()).tools,undefined);
  assert.equal(taskHeader(header()).exclude_tools,undefined);
  assert.throws(()=>taskHeader(header('5m','inference').replace('@mode inference','@mode inference\n * @tools read;write')),/@tools/);
  assert.throws(()=>taskHeader(header('5m','inference').replace('@mode inference','@mode inference\n * @exclude_tools +read')),/@exclude_tools/);
  assert.deepEqual(taskHeader('/**\n * @start_time 02:00\n * @mode deterministic\n */'), {start_time:'02:00',mode:'deterministic',session:'fresh'});
  assert.throws(()=>taskHeader(header().replace('@every 5 minutes','@every 5 minutes\n * @quiet_window 1 month')), /fixed duration/);
});

test('optional daily starts and quiet periods leave ordinary tasks unchanged and persist one run per local night', async t => {
  const f=await fixture(t), order=[];
  f.setTime(Date.UTC(2026,0,31,20,30)); // 22:30 in Athens.
  await f.task(0,'ordinary.js',header());
  await f.task(0,'quiet.js',header().replace('@every 5 minutes','@every 5 minutes\n * @quiet_window 10m'));
  await f.task(0,'nightly.js','/**\n * @start_time 23:00\n * @quiet_window 30m\n * @mode inference\n */');
  let scheduler=new TaskScheduler({...f.options,timeZone:'Europe/Athens',execute:async task=>order.push(task.name)});
  assert.equal((await scheduler.pending()).length,0);
  f.advance(300000);
  assert.equal(await scheduler.tick(),true);
  assert.deepEqual(order,['ordinary.js']);
  await unlink(join(f.users[0].folder,'tasks/ordinary.js'));
  scheduler.gate.update('chat',{pid:process.pid,busy:true});
  f.setTime(Date.UTC(2026,1,1,3,45)); // Reply finishes at 05:45, with no cutoff.
  assert.equal(await scheduler.tick(),false);
  scheduler.gate.remove('chat');
  f.advance(600000);
  assert.equal(await scheduler.tick(),true);
  assert.deepEqual(order,['ordinary.js','quiet.js']);
  await unlink(join(f.users[0].folder,'tasks/quiet.js'));
  assert.equal(await scheduler.tick(),false);
  f.advance(1200000);
  assert.equal(await scheduler.tick(),true);
  assert.equal(await scheduler.tick(),false);
  await scheduler.close();
  scheduler=new TaskScheduler({...f.options,timeZone:'Europe/Athens',execute:async task=>order.push(task.name)});
  assert.equal(await scheduler.tick(),false);
  f.setTime(Date.UTC(2026,1,1,21,15)); // Next local 23:15, less than 24h since the delayed run.
  assert.equal(await scheduler.tick(),true);
  assert.equal(await scheduler.tick(),false);
  assert.deepEqual(order,['ordinary.js','quiet.js','nightly.js','nightly.js']);
  assert.equal(scheduler.errors.size,0);
  await scheduler.close();
});

test('chat activity during task admission restarts the requested quiet period', async t => {
  const f=await fixture(t), order=[];
  await f.task(0,'quiet.js',header().replace('@every 5 minutes','@every 5 minutes\n * @quiet_window 10m'));
  const scheduler=new TaskScheduler({...f.options,execute:async task=>order.push(task.name)});
  await scheduler.pending();f.advance(600000);
  const [task]=await scheduler.pending();
  scheduler.gate.update('chat',{pid:process.pid,busy:true});
  const waiting=scheduler.run(task);
  f.advance(300000);scheduler.gate.remove('chat');await waiting;
  assert.deepEqual(order,[]);
  assert.equal(await scheduler.tick(),false);
  f.advance(600000);
  assert.equal(await scheduler.tick(),true);
  assert.deepEqual(order,['quiet.js']);
  await scheduler.close();
});

test('one FIFO queue spans users, survives restart and skips failed or removed tasks', async t => {
  const f=await fixture(t), entered=deferred(), finish=deferred(), order=[];
  await f.task(0,'early.js',header());
  let scheduler=new TaskScheduler({...f.options,execute:async task=>{order.push(task.user.id+'/'+task.name);entered.resolve();await finish.promise;}});
  assert.equal(await scheduler.tick(),false);
  f.advance(1000);await f.task(1,'later.js',header());await scheduler.pending();
  f.advance(301000);
  const running=scheduler.tick();await entered.promise;
  assert.equal(await scheduler.tick(),false);
  finish.resolve();await running;
  await scheduler.close();
  scheduler=new TaskScheduler({...f.options,execute:async task=>{order.push(task.user.id+'/'+task.name);throw new Error('A controlled failure');}});
  assert.equal(await scheduler.tick(),true);
  assert.deepEqual(order,['first/early.js','second/later.js']);
  assert.equal(await scheduler.tick(),false);
  await unlink(join(f.users[0].folder,'tasks/early.js'));await scheduler.pending();
  const state=JSON.parse(await readFile(join(f.users[0].folder,'.pi/runtime/tasks.json'),'utf8'));
  assert.equal(state.tasks['early.js'],undefined);
  await scheduler.close();
});

test('all frontend chats have priority and a running task waits between calls', async t => {
  const f=await fixture(t), first=deferred(), finish=deferred(), second=deferred(), order=[];
  await f.task(0,'job.js',header());
  const scheduler=new TaskScheduler({...f.options,execute:async(_task,_context,control)=>{
    order.push('first call');first.resolve();await finish.promise;control.release();
    const release=await control.gate.privateStep('model','second call');
    order.push('second call');release();second.resolve();
  }});
  await scheduler.pending();f.advance(300001);
  scheduler.gate.update('frontend-first',{pid:process.pid,busy:true});
  assert.equal(await scheduler.tick(),false);
  scheduler.gate.remove('frontend-first');
  const work=scheduler.tick();await first.promise;
  scheduler.gate.update('frontend-second',{pid:process.pid,busy:true});order.push('chat admitted');
  finish.resolve();
  assert.deepEqual(order,['first call','chat admitted']);
  scheduler.gate.remove('frontend-second');
  await second.promise;await work;await scheduler.close();
  assert.deepEqual(order,['first call','chat admitted','second call']);
});

test('deterministic JS and TS execute once in their owner cwd without inference', async t => {
  const f=await fixture(t);
  await f.task(0,'example.js',header()+`export default async ({user})=>{const {writeFile}=await import('node:fs/promises');await writeFile('tasks/output.txt',user+':'+process.cwd());};`);
  await f.task(1,'example.ts',header()+`export default async ({user}:{user:string})=>{const {writeFile}=await import('node:fs/promises');await writeFile('tasks/output.txt',user+':'+process.cwd());};`);
  const scheduler=new TaskScheduler({...f.options,execute:runTask});
  await scheduler.pending();f.advance(300001);
  await scheduler.tick();await scheduler.tick();
  for(const user of f.users)assert.equal(await readFile(join(user.folder,'tasks/output.txt'),'utf8'),user.id+':'+user.folder);
  assert.equal(await scheduler.tick(),false);
  assert.equal(scheduler.errors.size,0);
  await scheduler.close();
});

test('manual requests survive restart, stay with their owner and wait for chat without changing the schedule', async t => {
  const f = await fixture(t), seen = [];
  const source = '/**\n * @start_time 23:00\n * @quiet_window 30m\n * @mode deterministic\n */\nexport default () => {};';
  await f.task(0, 'manual.js', source); await f.task(1, 'manual.js', source);
  let scheduler = new TaskScheduler({ ...f.options, execute: async task => seen.push(task.user.id) });
  await scheduler.pending();
  const scheduled = structuredClone(scheduler.state(f.users[0].folder).value.tasks['manual.js']);
  scheduler.gate.update('chat', { pid: process.pid, busy: true });
  const receipt = await scheduler.request('first', 'manual.js', 'first-invocation');
  assert.equal(receipt.status, 'queued');
  assert.deepEqual(await scheduler.request('first', 'manual.js', 'first-invocation'), receipt);
  f.advance(1); await scheduler.request('second', 'manual.js', 'second-invocation');
  assert.equal(await scheduler.tick(), false); assert.deepEqual(seen, []);
  await assert.rejects(scheduler.request('first', '../second/tasks/manual.js', 'bad-path'), /filename/);
  await symlink(join(f.users[1].folder, 'tasks/manual.js'), join(f.users[0].folder, 'tasks/leak.js'));
  await assert.rejects(scheduler.request('first', 'leak.js', 'bad-link'), /outside/);
  await assert.rejects(scheduler.request('missing-user', 'manual.js', 'bad-owner'), /owner/);
  await scheduler.close();
  scheduler = new TaskScheduler({ ...f.options, tickMs: 86400000, execute: async task => seen.push(task.user.id) });
  scheduler.gate.update('chat', { pid: process.pid, busy: true });
  scheduler.start();
  await until(() => scheduler.gate.jobs.length === 2);
  scheduler.gate.remove('chat');
  await until(() => seen.length === 2 && !scheduler.running);
  assert.deepEqual(seen, ['first', 'second']);
  assert.deepEqual(scheduler.state(f.users[0].folder).value.tasks['manual.js'], scheduled);
  assert.equal((await scheduler.request('first', 'manual.js', 'first-invocation')).status, 'started');
  assert.equal(await scheduler.tick(), false, 'repeated invocation queued another run');
  await scheduler.close();
});

test('a manual daily run skips quiet time without consuming an overdue scheduled run', async t => {
  const f = await fixture(t), seen = [];
  f.setTime(Date.UTC(2026, 0, 31, 23, 10));
  await f.task(0, 'daily.js', '/**\n * @start_time 23:00\n * @quiet_window 1h\n * @mode deterministic\n */');
  const scheduler = new TaskScheduler({ ...f.options, timeZone: 'UTC', execute: async task => seen.push(task.request ?? 'scheduled') });
  await scheduler.pending();
  const row = scheduler.state(f.users[0].folder).value.tasks['daily.js'], next = row.nextRun;
  await scheduler.request('first', 'daily.js', 'manual');
  await until(() => seen.length === 1 && !scheduler.running);
  assert.equal(row.nextRun, next); assert.equal(row.lastStarted, undefined);
  assert.equal(await scheduler.tick(), false);
  f.advance(3600000); await scheduler.tick();
  assert.deepEqual(seen, ['manual', 'scheduled']);
  await scheduler.close();
});

test('manual requests enter the shared FIFO queue without starting or ticking the scheduler', async t => {
  const f = await fixture(t), seen = [], finish = deferred();
  await f.task(0, 'manual.js', header('6 months'));
  await f.task(1, 'manual.js', header('6 months'));
  const scheduler = new TaskScheduler({ ...f.options, execute: async task => seen.push(task.user.id) });
  const earlier = scheduler.gate.background('earlier-reflection', () => finish.promise);
  await Promise.all([
    scheduler.request('first', 'manual.js', 'same-key'),
    scheduler.request('first', 'manual.js', 'same-key'),
  ]);
  await scheduler.request('second', 'manual.js', 'same-key');
  assert.equal(scheduler.gate.jobs.length, 3, 'manual requests were not submitted directly or were duplicated');
  assert.deepEqual(seen, []);
  finish.resolve(); await earlier;
  await until(() => seen.length === 2 && !scheduler.running);
  assert.deepEqual(seen, ['first', 'second']);
  assert.equal((await scheduler.request('first', 'manual.js', 'same-key')).status, 'started');
  assert.equal(scheduler.gate.jobs.length, 0);
  await scheduler.close();
});
