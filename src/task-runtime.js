import { randomUUID } from 'node:crypto';
import { Client } from './client.js';
import { loadConfig, TASK_MARKER } from './config.js';

export default function scheduledTask(pi) {
  pi.registerFlag('scheduled-task', { description: 'Scheduled task definition path', type: 'string' });
  pi.registerFlag('subconscious-config', { description: 'Originating coordinator configuration', type: 'string' });
  pi.registerFlag('task-owner', { description: 'Task owner user ID', type: 'string' });
  pi.registerFlag('task-name', { description: 'Task filename', type: 'string' });
  let client, turnToken;
  const releaseTurn = async () => { if (turnToken) { const token = turnToken; turnToken = undefined; await client.call('task.release', { token }, { timeout: 0 }); } };
  pi.on('session_start', async (_event, ctx) => {
    if (!ctx.sessionManager.getEntries().some(entry => entry.type === 'custom' && entry.customType === TASK_MARKER)) pi.appendEntry(TASK_MARKER, { file: pi.getFlag('scheduled-task') });
    pi.setActiveTools(pi.getActiveTools().filter(name => !['subconscious_reflect', 'run_task'].includes(name)));
    client = new Client(loadConfig(pi.getFlag('subconscious-config')));
  });
  pi.on('turn_start', async (_event, ctx) => {
    turnToken = randomUUID();
    try { await client.call('task.enter', { token: turnToken, id: `${pi.getFlag('task-owner')}/${pi.getFlag('task-name')}` }, { timeout: 0, signal: ctx.signal }); }
    catch (error) { turnToken = undefined; ctx.abort(); throw error; }
  });
  pi.on('turn_end', releaseTurn);
  pi.on('agent_settled', releaseTurn);
  pi.on('session_shutdown', releaseTurn);
  pi.registerCommand('task-run', { description: 'Run the scheduled prompt in this task’s conversation', handler: text => {
    const { prompt, owner } = JSON.parse(text);
    pi.sendMessage({ customType: TASK_MARKER, display: false,
      content: `Scheduled task ${owner.task} belongs to ${owner.id}. Its source directory is ${owner.cwd}; resolve that user’s task inputs and daily logs there.\n\n${prompt}`, details: { owner } }, { triggerTurn: true });
  } });
}