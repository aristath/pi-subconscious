import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PiProcess } from './rpc.js';
import { piRequest } from './native.js';
import { assertProfilePath } from './config.js';

export class PiSessions {
  constructor(runtime, options = {}) { this.runtime = runtime; this.sessions = new Map(); this.observations = new Map(); this.request = options.requestPi ?? piRequest; }
  inspect(id, includeContext = false) {
    const session = this.sessions.get(id), request = this.observations.get(id);
    return { streaming: session?.busy ?? false, currentMessage: session?.currentMessage ?? null, pendingToolCalls: [], contextUsage: session?.contextUsage ?? null,
      request: request ? { ...request, context: undefined } : null, ...(includeContext ? { context: request?.context ?? null } : {}) };
  }
  async prepare(row) {
    const { config, store } = this.runtime;
    if (row.sessionFile) assertProfilePath(config, row.sessionFile);
    const actions = Object.fromEntries(Object.entries(store.state.actions).filter(([,action]) => action.conversationId === row.id));
    for (const [key, action] of Object.entries(actions)) if (action.status === 'started' && action.name === 'subconscious_start_chat' && store.state.chatPlans[key]) await this.runtime.startChat(store.state.chatPlans[key], key, store.state.chatPlans[key].model);
    const result = await this.request({ ...config, workspace: config.executionCwd }, 'private.prepare', { row, directory: join(config.dataDir, 'sessions'), cwd: config.executionCwd, storeId: config.storeId, actions, receipts: store.state.receipts });
    store.change(state => {
      Object.assign(state.actions, result.actions);
      Object.assign(store.row(row.id), { sessionFile: result.file, sessionId: result.sessionId, blocked: result.blocked, blockedAction: result.blockedAction });
    });
    if (result.blocked) throw new Error(result.blocked);
    return result;
  }
  async open(row) {
    if (this.sessions.has(row.id)) return this.sessions.get(row.id);
    const { config } = this.runtime, result = await this.prepare(row);
    const peer = new PiProcess({ cwd: config.executionCwd, command: config.piCommand, args: ['--approve', '--session', result.file,
      '-e', fileURLToPath(new URL('./private-runtime.js', import.meta.url)), '--subconscious-config', config.configPath, '--subconscious-id', row.id],
      env: { ...process.env, PI_CODING_AGENT_DIR: config.agentDir }, onEvent: event => {
        if (event.type === 'message_update') { const request = this.observations.get(row.id); if (request && !request.firstOutputAt) request.firstOutputAt = Date.now(); }
        if (event.type === 'message_update') peer.currentMessage = event.assistantMessageEvent?.message ?? peer.currentMessage;
        if (event.type === 'message_end') peer.currentMessage = event.message;
        if (event.type === 'agent_settled') peer.settled?.(event);
        if (event.type === 'extension_error') this.runtime.errors.set(row.id, event.error);
      } });
    await peer.request('get_state');
    peer.exited.then(() => { if (this.sessions.get(row.id) === peer) { this.sessions.delete(row.id); this.runtime.releaseSteps?.(row.id); } });
    this.sessions.set(row.id, peer); return peer;
  }
  async step(row) {
    const peer = await this.open(row), wakeId = this.runtime.store.row(row.id).wakeId;
    peer.busy = true;
    const settled = new Promise(resolve => { peer.settled = resolve; });
    try {
      const { commands } = await peer.request('get_commands');
      if (!commands.some(command => command.name === 'subconscious-step')) throw new Error('Private Pi extension failed to load.');
      await peer.request('prompt', { message: '/subconscious-step ' + JSON.stringify({ wakeId, content: row.content }) });
      await Promise.race([settled, peer.exited.then(() => { throw new Error('Private Pi stopped before settling.'); })]);
      const { messages } = await peer.request('get_messages'), last = messages.findLast(message => message.role === 'assistant');
      if (this.runtime.store.row(row.id).status === 'active' && ['error', 'aborted'].includes(last?.stopReason)) throw new Error(last.errorMessage ?? 'Private generation failed');
      this.runtime.store.change(() => { this.runtime.store.row(row.id).transcriptCommitted = true; });
      return { hasTools: last?.content.some(part => part.type === 'toolCall') ?? false };
    } finally { peer.busy = false; peer.settled = undefined; }
  }
  async recover() {
    for (const row of this.runtime.store.list()) {
      if (!row.sessionFile || !existsSync(row.sessionFile)) continue;
      try {
        const { branch } = await this.prepare(row);
        if (!row.inProgress || row.stepCompleted) continue;
        const wake = branch.findLastIndex(e => e.type === 'custom_message' && e.customType === 'pi-subconscious:wake' && e.details?.wakeId === row.wakeId);
        const assistant = branch.slice(wake + 1).findLast(e => e.type === 'message' && e.message.role === 'assistant');
        if (wake >= 0 && assistant && !['error', 'aborted'].includes(assistant.message.stopReason)) this.runtime.store.change(() => { this.runtime.store.row(row.id).stepCompleted = { wakeId: row.wakeId, hasTools: assistant.message.content.some(p => p.type === 'toolCall'), completedAt: Date.parse(assistant.timestamp) }; });
      } catch (error) { this.runtime.errors.set(row.id, error.message); }
    }
  }
  async close() { await Promise.all([...this.sessions.values()].map(peer => peer.close())); this.sessions.clear(); }
  async chats(args) {
    const { config } = this.runtime;
    const rows = await this.request(config, 'sessions.list', { directory: join(config.workspace, 'sessions') });
    const key = path => createHash('sha256').update(path).digest('hex');
    if (args.action === 'list') return rows.slice(args.offset ?? 0, (args.offset ?? 0) + (args.limit ?? 30)).map(row => ({ id: key(row.path), title: row.name ?? row.firstMessage, modified: row.modified }));
    const row = rows.find(row => key(row.path) === args.id);
    if (!row) throw new Error('Conversation not found');
    const messages = await this.request(config, 'session.messages', { path: row.path });
    return { id: args.id, messages: messages.slice(args.offset ?? 0, (args.offset ?? 0) + (args.limit ?? 30)), total: messages.length };
  }
}
