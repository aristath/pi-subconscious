import { createServer } from 'node:http';
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, chmodSync, statSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { piRequest } from './native.js';
import { Store, text } from './store.js';
import { Gate } from './gate.js';
import { assertProfilePath } from './config.js';
import { PiSessions } from './sessions.js';

function alive(pid) { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } }
export function acquireLock(config) {
  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  const path = join(config.dataDir, 'service.lock');
  const owner = join(path, 'owner.json');
  try { mkdirSync(path, { mode: 0o700 }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let record;
    try { record = JSON.parse(readFileSync(owner, 'utf8')); } catch { /* An owner may be publishing its record. */ }
    if (record?.pid && alive(record.pid)) throw new Error('A coordinator is already running or starting for this data store');
    if (!record?.pid && Date.now() - statSync(path).mtimeMs < 10000) throw new Error('A coordinator is starting for this data store');
    rmSync(path, { recursive: true });
    mkdirSync(path, { mode: 0o700 });
  }
  const token = randomUUID();
  writeFileSync(owner, JSON.stringify({ pid: process.pid, token }), { mode: 0o600 });
  return () => {
    try { if (JSON.parse(readFileSync(owner, 'utf8')).token === token) rmSync(path, { recursive: true }); } catch { /* Already released. */ }
  };
}
function readJSON(body) {
  try { return JSON.parse(body); } catch { throw new Error('Request must be valid JSON'); }
}
function boundedPage(entries, args) {
  const offset = Number.isInteger(args.offset) && args.offset >= 0 ? args.offset : 0;
  const limit = Number.isInteger(args.limit) && args.limit > 0 ? Math.min(args.limit, 100) : 30;
  return { entries: entries.slice(offset, offset + limit), total: entries.length, next: offset + limit < entries.length ? offset + limit : null };
}

export class Coordinator {
  constructor(config, options = {}) {
    this.config = config;
    this.store = options.store ?? new Store(config);
    this.ownsGate = !options.gate;
    this.gate = options.gate ?? new Gate(undefined, options.isAlive);
    this.controller = new AbortController(); this.signal = this.controller.signal;
    this.errors = new Map(); this.missingTools = new Map();
    this.sessions = options.sessions ?? new PiSessions(this, options);
    this.running = false; this.stopping = false;
    this.requestPi = options.requestPi ?? piRequest;
    this.enqueueTask = options.enqueueTask;
    this.steps = new Map();
    for (const row of this.store.list()) if (row.stepCompleted) this.completeStep(row.id, row.stepCompleted);
  }
  async startChat(args, key, model) {
    const { store, config } = this;
    if (store.state.receipts[key]) return store.state.receipts[key];
    text(args.title, 'title'); text(args.message, 'message');
    let plan = store.state.chatPlans[key];
    if (!plan) {
      const created = await this.requestPi(config, 'chat.create', { cwd: config.workspace, directory: join(config.workspace, 'sessions') });
      plan = { ...created, title: args.title, message: args.message, model: { api: model?.api, provider: model?.provider, id: model?.id } };
      store.change(state => { state.chatPlans[key] = plan; });
    }
    assertProfilePath(config, plan.file);
    const created = await this.requestPi(config, 'chat.create', { path: plan.file, ...plan, key });
    return store.once(key, state => {
      const id = randomUUID(), result = { id, ...created };
      state.deliveries[id] = { ...result, kind: 'new-chat', status: 'available', createdAt: Date.now() }; return result;
    });
  }
  chats(args) { return this.sessions.chats(args); }
  foreground(params) {
    if (typeof params.id !== 'string' || typeof params.sessionId !== 'string' || typeof params.file !== 'string') throw new Error('A foreground session registration is required');
    const data = { pid: params.pid, busy: params.busy === true, file: params.file, sessionId: params.sessionId };
    this.gate.update(params.id, data);
    return data;
  }
  async sourceClient(id) {
    const client = this.gate.clients.get(id);
    if (!client) throw new Error('Foreground registration expired; reconnect before continuing');
    assertProfilePath(this.config, client.file);
    const header = await this.requestPi(this.config, 'session.header', { path: client.file });
    if (header.id !== client.sessionId) throw new Error('The registered source Pi session is unavailable');
    return client;
  }
  async pending(id) {
    const registered = this.gate.clients.get(id);
    if (!registered) throw new Error('Foreground registration expired; reconnect before continuing');
    // A fresh Pi session has its filename before its first message is persisted.
    if (!registered.file || !existsSync(registered.file)) return [];
    const deliveries = Object.values(this.store.state.deliveries).filter(row => row.kind !== 'new-chat' && row.status === 'pending' && row.source.file === realpathSync(registered.file) && row.source.sessionId === registered.sessionId);
    if (!deliveries.length) return [];
    const client = await this.sourceClient(id);
    const checks = await this.requestPi(this.config, 'source.deliveries', { path: client.file, sessionId: client.sessionId, deliveries });
    const received = new Set(checks.filter(row => row.received).map(row => row.id));
    const present = new Set(checks.filter(row => row.present).map(row => row.id));
    const pending = [];
    let changed = false;
    for (const delivery of Object.values(this.store.state.deliveries)) {
      if (delivery.kind === 'new-chat' || delivery.status !== 'pending') continue;
      if (delivery.source.file !== realpathSync(client.file) || delivery.source.sessionId !== client.sessionId) continue;
      if (received.has(delivery.id)) {
        delivery.status = 'delivered'; delivery.deliveredAt = Date.now(); changed = true;
      } else if (present.has(delivery.id)) pending.push({ id: delivery.id, content: delivery.content });
    }
    if (changed) this.store.save();
    return pending;
  }
  async inspect(id, args = {}) {
    const row = this.store.row(id);
    assertProfilePath(this.config, row.sessionFile);
    const entries = row.sessionFile && existsSync(row.sessionFile) ? await this.requestPi(this.config, 'session.entries', { path: row.sessionFile }) : [];
    return { conversation: structuredClone(row), ...boundedPage(entries, args), transcriptWarning: row.sessionFile && !existsSync(row.sessionFile) ? 'The saved transcript is unavailable; it has not been deleted.' : null, live: this.sessions.inspect?.(id) ?? null };
  }
  resolveAction(args) {
    const action = this.store.state.actions[args.key];
    if (!action || action.status !== 'started') throw new Error('No unresolved action with this receipt');
    if (this.actionActive(action)) throw new Error('The original action is still running; wait for it to settle');
    if (this.store.row(action.conversationId).blockedAction !== args.key) throw new Error('This action is not awaiting resolution; inspect its original run');
    if (typeof args.executed !== 'boolean') throw new Error('Specify whether the action executed after inspecting its real outcome');
    if (args.executed && (!args.result || !Array.isArray(args.result.content))) throw new Error('An executed action needs its observed result content');
    return this.store.change(() => {
      action.status = 'completed';
      action.result = { role: 'toolResult', toolCallId: action.callId, toolName: action.name,
        content: args.executed ? args.result.content : [{ type: 'text', text: 'The operator verified this action did not execute. It may be requested again if still wanted.' }],
        details: args.executed ? args.result.details : undefined, isError: args.executed ? !!args.result.isError : true, timestamp: Date.now() };
      const row = this.store.row(action.conversationId);
      delete row.blocked; delete row.blockedAction; delete row.retryAt; row.nextWake = Date.now();
      // Force reopening so repaired receipts are projected into Pi history.
      const session = this.sessions.sessions?.get(row.id);
      void session?.close(); this.sessions.sessions?.delete(row.id);
      return { resolved: true };
    });
  }
  actionActive(action) { return [...this.steps.values()].some(step => step.id === action.conversationId); }
  releaseSteps(id) { for (const [token, step] of this.steps) if (step.id === id) { step.release(); this.steps.delete(token); } }
  async call(method, params = {}) {
    switch (method) {
      case 'private.row': return this.store.row(params.id);
      case 'private.enter': {
        const row = this.store.row(params.id);
        if (row.status !== 'active' || row.blocked) throw new Error('This private conversation has finished or requires recovery.');
        const release = await this.gate.privateStep('turn', row.id, this.signal, () => this.store.state.paused);
        this.steps.set(params.token, { id: row.id, release });
        return { admitted: true };
      }
      case 'private.observe': {
        const request = this.sessions.observations?.get(params.id);
        if (params.finished) { if (request) request.finishedAt = Date.now(); }
        else this.sessions.observations?.set(params.id, { queuedAt: Date.now(), startedAt: Date.now(), context: params.payload, model: params.model, messageCount: params.payload?.messages?.length ?? 0 });
        return {};
      }
      case 'private.release': this.steps.get(params.token)?.release(); this.steps.delete(params.token); return { released: true };
      case 'task.enter': {
        const release = await this.gate.privateStep('turn', params.id, this.signal, () => false);
        this.steps.set(params.token, { id: params.id, release });
        return { admitted: true };
      }
      case 'task.release': this.steps.get(params.token)?.release(); this.steps.delete(params.token); return { released: true };
      case 'task.cleanup': this.releaseSteps(params.id); return { released: true };
      case 'private.action':
        if (this.steps.get(params.turnToken)?.id !== params.id) throw new Error('This private turn is not admitted.');
        if (this.store.state.actions[params.token]) throw new Error('This invocation already has a receipt; it was not replayed.');
        this.store.change(state => { state.actions[params.token] = { status: 'started', conversationId: params.id, name: params.tool, args: params.args, callId: params.callId, sessionId: params.sessionId, startedAt: Date.now() }; });
        return { recorded: true };
      case 'private.complete':
        this.store.change(state => { const action = state.actions[params.token]; if (action?.conversationId === params.id) Object.assign(action, { status: 'completed', result: params.result }); });
        return { completed: true };
      case 'private.operation': {
        const row = this.store.row(params.id);
        switch (params.tool) {
          case 'subconscious_source': if (row.kind !== 'reflection') throw new Error('This reflection has no source.'); return row.source.context;
          case 'subconscious_return': return this.store.finish(row.id, params.args.content, params.key);
          case 'subconscious_finish': return this.store.finish(row.id, undefined, params.key);
          case 'subconscious_start_chat': return this.startChat(params.args, params.key, params.model);
          case 'subconscious_chats': return this.chats(params.args);
          default: throw new Error('Unknown private tool.');
        }
      }
      case 'ping': return { pid: process.pid, storeId: this.config.storeId, stopping: this.stopping };
      case 'status': return { paused: this.store.state.paused, active: this.gate.active, clients: [...this.gate.clients].map(([id, value]) => ({ id, ...value })), conversations: this.store.list(), pendingDeliveries: Object.values(this.store.state.deliveries).filter(delivery => delivery.status === 'pending').map(delivery => ({ id: delivery.id, sessionId: delivery.source.sessionId, file: delivery.source.file })), missingTools: Object.fromEntries(this.missingTools), errors: Object.fromEntries(this.errors) };
      case 'pause': this.store.change(state => { state.paused = params.paused !== false; }); this.gate.wake(); return { paused: this.store.state.paused };
      case 'list': return this.store.list();
      case 'read': return this.inspect(params.id, params);
      case 'inspect.context': this.store.row(params.id); return this.sessions.inspect?.(params.id, true) ?? { context: null };
      case 'actions': return Object.entries(this.store.state.actions).filter(([, action]) => action.status === 'started').map(([key, action]) => ({ key, ...action, active: this.actionActive(action), resolvable: this.store.row(action.conversationId).blockedAction === key && !this.actionActive(action) }));
      case 'resolve': return this.resolveAction(params);
      case 'foreground.update': this.foreground(params); return { registered: true };
      case 'foreground.leave': this.gate.remove(params.id); return { removed: true };
      case 'reflection.create': {
        const client = await this.sourceClient(params.clientId);
        const source = await this.requestPi(this.config, 'source.context', { path: client.file, callId: params.callId });
        const result = this.store.reflect(source.thought, source, `${source.sessionId}:${source.entryId}:${source.callId}`);
        this.gate.wake(); return { id: result.id, status: result.status };
      }
      case 'task.enqueue':
        if (!this.enqueueTask) throw new Error('This host has not enabled task execution.');
        return this.enqueueTask(params.task, params.key);
      case 'deliveries': return this.pending(params.clientId);
      case 'notifications': return Object.values(this.store.state.deliveries).filter(row => row.kind === 'new-chat' && row.status === 'available');
      case 'notification.ack': this.store.change(state => { const row = state.deliveries[params.id]; if (!row || row.kind !== 'new-chat') throw new Error('Notification not found'); row.status = 'acknowledged'; }); return { acknowledged: true };
      case 'stop': this.requestStop?.(); return { stopping: true };
      default: throw new Error('Unknown service method');
    }
  }
  async tick() {
    if (this.running || this.stopping || this.store.state.paused || this.gate.busy()) return false;
    const row = this.store.due()[0];
    if (!row) return false;
    this.running = true;
    try {
      await this.gate.background(`${this.config.storeId}/${row.id}`, async () => {
        if (this.stopping || this.store.state.paused) return;
        this.store.change(() => { const current = this.store.row(row.id); current.wakeId ??= randomUUID(); current.inProgress = true; });
        const result = await this.sessions.step(this.store.row(row.id));
        this.completeStep(row.id, this.store.row(row.id).stepCompleted ?? { ...result, completedAt: Date.now() });
        this.errors.delete(row.id);
      }, this.signal);
    } catch (error) {
      if (!this.stopping && this.store.row(row.id).status === 'active') {
        this.errors.set(row.id, error.message);
        this.store.change(() => { const current = this.store.row(row.id); current.error = error.message; current.retryAt = Date.now() + this.config.errorRetryMs; current.lastStep = Date.now(); });
      }
    } finally { this.running = false; }
    return true;
  }
  // Nearest future wake/retry among active reflections; null when none is scheduled.
  nextWakeTime() {
    let next = null;
    for (const row of this.store.list()) {
      if (row.kind !== 'reflection' || row.status !== 'active' || row.blocked) continue;
      const at = row.retryAt ?? row.nextWake;
      if (Number.isFinite(at) && (next === null || at < next)) next = at;
    }
    return next;
  }
  completeStep(id, result) {
    this.store.change(() => {
      const current = this.store.row(id);
      current.lastStep = result.completedAt; current.updatedAt = current.lastStep;
      delete current.retryAt; delete current.error; delete current.inProgress; delete current.wakeId; delete current.stepCompleted;
      current.nextWake = current.lastStep;
    });
  }
  async stop() {
    this.stopping = true;
    // Let a currently executing model/tool finish. Wake blocked boundaries so
    // they can settle without starting another step. Never kill external work.
    this.controller.abort();
    if (this.ownsGate) this.gate.stop();
    else this.gate.wake();
    while (this.running) await new Promise(resolve => setTimeout(resolve, 10));
    await this.sessions.close();
  }
}

export async function startService(config, options = {}) {
  const releaseLock = acquireLock(config);
  let coordinator, server;
  try {
    coordinator = new Coordinator(config, options);
    await coordinator.sessions.recover?.();
    for (const row of coordinator.store.list()) if (row.stepCompleted) coordinator.completeStep(row.id, row.stepCompleted);
    if (process.platform !== 'win32' && existsSync(config.socketPath)) rmSync(config.socketPath);
    server = createServer(async (request, response) => {
      try {
        if (request.method !== 'POST' || request.url !== '/') throw new Error('Use POST /');
        let body = '';
        for await (const chunk of request) { body += chunk; if (Buffer.byteLength(body) > 16777216) throw new Error('Request exceeds 16 MiB'); }
        const { method, params } = readJSON(body);
        const result = await coordinator.call(method, params);
        response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ result }));
      } catch (error) {
        response.writeHead(400, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: error.message }));
      }
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(config.socketPath, resolve); });
    if (process.platform !== 'win32') chmodSync(config.socketPath, 0o600);
    let timer, closed;
    let closing = false;
    const close = async () => {
      if (closing) return closed;
      closing = true;
      closed = (async () => {
        clearTimeout(timer);
        await coordinator.stop();
        await new Promise(resolve => { server.close(resolve); server.closeIdleConnections(); });
        if (process.platform !== 'win32' && existsSync(config.socketPath)) rmSync(config.socketPath);
        releaseLock();
      })();
      return closed;
    };
    coordinator.requestStop = () => { setImmediate(() => void close()); };
    // Event-driven: run due reflections back-to-back, then sleep until a gate
    // wake (new reflection, chat idle, pause toggle) or the nearest retry timer.
    const pump = async () => {
      while (!closing) {
        let ran = false;
        try { ran = await coordinator.tick(); }
        catch (error) { coordinator.errors.set('service', error.message); }
        if (closing) break;
        if (ran) continue;
        const next = coordinator.nextWakeTime();
        timer = next === null ? null : setTimeout(() => coordinator.gate.wake(), Math.max(0, next - Date.now()));
        timer?.unref?.();
        const waiting = coordinator.gate.wait(coordinator.signal).catch(() => {});
        // Re-check after registering so a wake between tick and wait is not lost.
        if (!coordinator.store.state.paused && !coordinator.gate.busy() && coordinator.store.due().length) coordinator.gate.wake();
        await waiting;
        if (timer) clearTimeout(timer);
      }
    };
    if (options.schedule !== false) void pump();
    return { coordinator, server, close };
  } catch (error) {
    server?.close(); releaseLock(); throw error;
  }
}
