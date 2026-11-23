import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { Type } from 'typebox';
import { Client } from './client.js';
import { loadConfig, TASK_MARKER } from './config.js';
import { deliveredIds } from './native-operations.js';
import { toolResult, PRIVATE_MARKER, RETURN_TYPE } from './private-extension.js';
import { invocationKey } from './invocations.js';

export function createExtension(deps = {}) {
return function subconsciousExtension(pi) {
  let client, ctx, clientId, disabled = false, lastWarning;
  const warn = error => {
    const message = error.message ?? String(error);
    if (message !== lastWarning) ctx?.ui.notify(`Subconscious: ${message}`, 'warning');
    lastWarning = message;
  };
  const registration = (context, busy) => ({ id: clientId, pid: process.pid, busy, file: context.sessionManager.getSessionFile() ?? '', sessionId: context.sessionManager.getSessionId() });
  // Busy claims are event-driven: a run starts and settles, a compaction runs,
  // the session shuts down. The host application registers its own in-process
  // workers directly on the gate; this socket registration serves standalone
  // Pi sessions (TUI/SSH). A crashed session's claim is cleared by the gate's
  // pid liveness check when background work next asks for admission.
  async function update(context, busy) {
    if (disabled || !client) return;
    ctx = context;
    await client.call('foreground.update', registration(context, busy));
    lastWarning = undefined;
  }
  async function stop() {
    if (client && clientId && !disabled) {
      try { await client.call('foreground.leave', { id: clientId }); } catch { /* The coordinator may already be gone. */ }
    }
    ctx = undefined; client = undefined;
  }
  pi.on('session_start', async (_event, context) => {
    disabled = context.sessionManager.getEntries().some(entry => entry.type === 'custom' && [PRIVATE_MARKER, TASK_MARKER].includes(entry.customType));
    if (disabled) return;
    ctx = context; clientId = randomUUID();
    client = new Client(loadConfig(pi.getSettings().subconscious?.configPath ?? join(context.cwd, '.pi/settings.json'), { agentDir: deps.agentDir, settings: pi.getSettings() }));
    try { await update(context, !context.isIdle()); } catch (error) { warn(error); }
  });
  pi.on('before_agent_start', async (_event, context) => {
    if (disabled || !client) return;
    try {
      await update(context, true);
      const known = deliveredIds(context.sessionManager);
      const deliveries = (await client.call('deliveries', { clientId })).filter(item => !known.has(item.id));
      if (deliveries.length) return { message: {
        customType: RETURN_TYPE, display: false,
        content: 'Selected reflections from your own private thinking. These are internal context, not new user messages:\n\n' + deliveries.map(item => item.content).join('\n\n'),
        details: { deliveryIds: deliveries.map(item => item.id) },
      } };
    } catch (error) { warn(error); }
  });
  pi.on('before_provider_request', async () => {
    if (disabled || !client) return;
    try {
      // The before_agent_start custom entry has now been persisted by Pi.
      // The service verifies the actual file before marking deliveries received.
      await client.call('deliveries', { clientId });
    } catch (error) { warn(error); }
  });
  pi.on('agent_settled', async (_event, context) => {
    if (disabled || !client) return;
    try { await update(context, false); await client.call('deliveries', { clientId }); } catch (error) { warn(error); }
  });
  pi.on('session_before_compact', async (_event, context) => {
    try { await update(context, true); } catch (error) { warn(error); }
  });
  pi.on('session_compact', async (_event, context) => {
    if (disabled || !client) return;
    try { await update(context, !context.isIdle()); } catch (error) { warn(error); }
  });
  pi.on('session_compact_failed', async (_event, context) => {
    if (disabled || !client) return;
    try { await update(context, !context.isIdle()); } catch (error) { warn(error); }
  });
  pi.on('session_shutdown', stop);

  pi.registerTool({
    name: 'run_task', label: 'Run task', executionMode: 'sequential',
    description: 'Submit a task from this user’s tasks/ directory directly to the shared execution queue, without waiting for a scheduler tick. Supply its .js or .ts filename. Skips its schedule and quiet period, keeps chat priority, and leaves its regular schedule unchanged. A queued receipt does not mean the task has completed.',
    parameters: Type.Object({ task: Type.String({ minLength: 1, description: 'Task filename, for example sleep.js.' }) }),
    async execute(callId, { task }, _signal, _update, context) {
      if (disabled) throw new Error('Request tasks from a foreground session.');
      await update(context, true);
      return toolResult(await client.call('task.enqueue', { task, key: invocationKey(context.sessionManager, callId) }));
    },
  });
  pi.registerTool({
    name: 'subconscious_reflect', label: 'Private reflection', executionMode: 'sequential',
    description: 'Set a thought aside in its own private Pi conversation. The runtime binds it to this exact chat. Only a successful receipt means it was saved.',
    parameters: Type.Object({ content: Type.String({ minLength: 1 }) }),
    async execute(callId, _args, _signal, _update, context) {
      if (disabled) throw new Error('Private reflection creation is a foreground tool');
      await update(context, true);
      return toolResult(await client.call('reflection.create', { clientId, callId }));
    },
  });
  pi.registerCommand('subconscious', {
    description: 'Private thinking: status, pause, resume, list, read <id>, actions, resolve <JSON>, notifications',
    async handler(args) {
      if (disabled || !client) return;
      const [command = 'status', ...tail] = args.trim().split(/\s+/);
      const value = tail.join(' ');
      let result;
      if (command === 'pause' || command === 'resume') result = await client.call('pause', { paused: command === 'pause' });
      else if (command === 'read') result = await client.call('read', { id: tail[0], offset: Number(tail[1] ?? 0) });
      else if (command === 'resolve') result = await client.call(command, JSON.parse(value));
      else if (['status', 'list', 'actions', 'notifications'].includes(command)) result = await client.call(command);
      else throw new Error('Use status, pause, resume, list, read <id>, actions, resolve <JSON>, or notifications');
      pi.sendMessage({ customType: 'pi-subconscious:inspection', content: JSON.stringify(result, null, 2), display: true }, { triggerTurn: false });
    },
  });
}

}
export default createExtension();