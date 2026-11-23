import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Gate } from '../src/gate.js';
import { startService } from '../src/service.js';
import { TaskScheduler } from '../src/tasks.js';
import { runTask } from '../src/task-runner.js';
import { fixture, until } from './helpers.js';

test('native parallel tools finish together; tasks and reflections share a queue and yield to active chats', { timeout: 30000 }, async t => {
  const gate = new Gate();
  let service, scheduler, root;
  t.after(async () => {
    if (root) for (const phase of ['task', 'reflection']) writeFileSync(join(root, 'release-' + phase), '');
    gate.remove('chat');
    const closing = service?.close(); await scheduler?.close(); await closing;
  });
  const f = fixture(t, { allowedTools: ['probe'] });
  root = f.root;
  const provider = join(f.root, 'parallel-provider.js'), marker = join(f.root, 'events.jsonl');
  writeFileSync(provider, `
    import { appendFileSync, existsSync } from 'node:fs';
    import { setTimeout as delay } from 'node:timers/promises';
    import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
    export default function(pi) {
      const record = event => appendFileSync(${JSON.stringify(marker)}, JSON.stringify(event)+'\\n');
      pi.registerTool({ name:'probe', label:'Probe', description:'Controlled local test tool.',
        parameters:{ type:'object', properties:{ phase:{type:'string'}, name:{type:'string'} }, required:['phase','name'] },
        async execute(_id, {phase,name}, signal) {
          record({kind:'tool',phase,name});
          while (name === 'a' && !existsSync(${JSON.stringify(f.root)}+'/release-'+phase)) await delay(5, undefined, {signal});
          return {content:[{type:'text',text:'Completed '+name}]};
        }
      });
      pi.registerProvider('synthetic', {
        api:'synthetic-api', apiKey:'synthetic-test-value', baseUrl:'https://synthetic.invalid',
        models:[{id:'default',name:'Synthetic default',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:262144,maxTokens:4096}],
        streamSimple(model, context) {
          const phase = JSON.stringify(context.messages).includes('Continue your private reflection.') ? 'reflection' : 'task';
          const done = context.messages.some(message => message.role === 'toolResult' && message.toolName === 'probe');
          record({kind:'model',phase,done});
          const tool = (name,args,id) => ({type:'toolCall',id,name,arguments:args});
          const content = done ? (phase === 'reflection' ? [tool('subconscious_finish',{},'finish')] : [{type:'text',text:'Done.'}])
            : ['a','b'].map(name => tool('probe',{phase,name},phase+'-'+name));
          const reason = content[0].type === 'toolCall' ? 'toolUse' : 'stop';
          const message = {role:'assistant',content,api:model.api,provider:model.provider,model:model.id,
            usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:reason,timestamp:Date.now()};
          const stream = createAssistantMessageEventStream();
          queueMicrotask(() => {stream.push({type:'done',reason,message});stream.end(message);});
          return stream;
        }
      });
    }`);
  rmSync(join(f.agentDir, 'models.json'));
  const settingsPath = join(f.agentDir, 'settings.json');
  writeFileSync(settingsPath, JSON.stringify({ ...JSON.parse(readFileSync(settingsPath, 'utf8')), extensions: [provider] }));
  mkdirSync(join(f.workspace, 'tasks'));
  writeFileSync(join(f.workspace, 'tasks/example.js'), '/**\n * @every 1s\n * @mode inference\n */\nexport default "Run the controlled probes.";');
  service = await startService(f.config, { gate, schedule: false });
  let now = Date.now();
  scheduler = new TaskScheduler({ gate, now: () => now, users: async () => [{ id: 'owner', admin: true, folder: f.workspace }],
    prepare: async () => ({ workspace: f.workspace, agentDir: f.agentDir }), execute: runTask });
  const events = () => existsSync(marker) ? readFileSync(marker, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
  await scheduler.pending(); now += 1000;
  const task = scheduler.tick();
  await until(() => events().filter(event => event.phase === 'task' && event.kind === 'tool').length === 2, 15000);
  const reflection = service.coordinator.tick();
  assert.equal(events().some(event => event.phase === 'reflection'), false);
  gate.update('chat', { pid: process.pid, busy: true });
  assert.equal(gate.busy(), true, 'foreground registers busy immediately, even mid-turn');
  writeFileSync(join(f.root, 'release-task'), '');
  await until(() => gate.waiters.size >= 2); // Next task turn and queued reflection.
  assert.equal(events().filter(event => event.kind === 'model').length, 1, 'background continued while chat was busy');
  gate.remove('chat'); await task;
  await until(() => events().filter(event => event.phase === 'reflection' && event.kind === 'tool').length === 2, 15000);
  assert.deepEqual(events().filter(event => event.kind === 'model').map(event => event.phase), ['task', 'task', 'reflection']);
  gate.update('chat', { pid: process.pid, busy: true });
  writeFileSync(join(f.root, 'release-reflection'), '');
  await until(() => gate.waiters.size > 0);
  assert.equal(events().filter(event => event.phase === 'reflection' && event.kind === 'model').length, 1);
  gate.remove('chat'); await reflection;
  assert.equal(service.coordinator.store.row('sample-reflection').status, 'finished');
  assert.equal(gate.active, null);
  assert.equal(gate.jobs.length, 0);
  const actions = Object.values(service.coordinator.store.state.actions);
  assert.equal(actions.filter(action => action.name === 'probe' && action.status === 'completed').length, 2);

  // Stopping while the next native turn waits must abort it, not just emit an
  // extension error and continue to the provider without admission.
  rmSync(join(f.root, 'release-task')); now += 1000;
  const stoppingTask = scheduler.tick();
  await until(() => events().filter(event => event.phase === 'task' && event.kind === 'tool').length === 4, 15000);
  gate.update('chat', { pid: process.pid, busy: true });
  writeFileSync(join(f.root, 'release-task'), '');
  await until(() => gate.waiters.size > 0);
  await scheduler.close(); await stoppingTask;
  assert.equal(events().filter(event => event.phase === 'task' && event.kind === 'model').length, 3);
  assert.equal(gate.active, null);
});
