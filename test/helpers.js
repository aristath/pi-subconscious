import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentSession, SessionManager, DefaultResourceLoader } from '@earendil-works/pi-coding-agent';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { loadConfig } from '../src/config.js';
import { Store } from '../src/store.js';
import { assistantMessage as nativeAssistantMessage } from '../src/native-operations.js';
export const syntheticModel = { api: 'synthetic-api', provider: 'synthetic', id: 'default' };
export const assistantMessage = content => nativeAssistantMessage(content, syntheticModel);

export function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
export async function until(fn, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await fn()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw new Error('Condition did not become true');
}
export const call = (name, args = {}, id = `call-${Math.random().toString(16).slice(2)}`) => ({ type: 'toolCall', id, name, arguments: args });
export function output(content = 'A synthetic private thought.') {
  const message = assistantMessage('');
  return { ...message, content: typeof content === 'string' ? [{ type: 'text', text: content }] : content, stopReason: Array.isArray(content) && content.some(part => part.type === 'toolCall') ? 'toolUse' : 'stop' };
}
export function fakeStream(handler) {
  return (model, context, options) => {
    const stream = createAssistantMessageEventStream();
    void (async () => {
      try {
        await options?.onPayload?.({ messages: context.messages }, model);
        const message = { ...await handler({ model, context, options }), provider: model.provider, model: model.id, api: model.api };
        stream.push({ type: 'start', partial: { ...message, content: [] } });
        stream.push({ type: 'done', reason: message.stopReason, message }); stream.end(message);
      } catch (error) {
        const message = { ...output(''), stopReason: 'error', errorMessage: error.message };
        stream.push({ type: 'error', reason: 'error', error: message }); stream.end(message);
      }
    })();
    return stream;
  };
}
export function fixture(t, overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'pcs-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workspace = join(root, 'workspace'), agentDir = join(workspace, 'agent');
  mkdirSync(agentDir, { recursive: true }); mkdirSync(join(workspace, '.pi'), { recursive: true });
  const model = id => ({ id, name: id, reasoning: false, input: ['text', 'image'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 262144, maxTokens: 4096 });
  writeFileSync(join(agentDir, 'models.json'), JSON.stringify({ providers: { synthetic: { api: 'openai-completions', baseUrl: 'http://synthetic.invalid/v1', apiKey: 'synthetic-test-value', models: [model('default'), model('override')] } } }));
  const path = join(workspace, '.pi', 'settings.json');
  const raw = { dataDir: join(workspace, 'subconscious'), initialRestMs: 0, ...overrides };
  const settings = { defaultProvider: 'synthetic', defaultModel: 'default', cacheWarming: 'off', retry: { enabled: false }, compaction: { enabled: false }, skills: ['!**'], subconscious: raw };
  writeFileSync(join(agentDir, 'settings.json'), JSON.stringify(settings));
  writeFileSync(path, JSON.stringify({ subconscious: raw }));
  const trusted = { agentDir };
  const config = loadConfig(path, trusted);
  const store = new Store(config), now = Date.now();
  store.change(state => { state.conversations['sample-reflection'] = { id: 'sample-reflection', kind: 'reflection', owner: 'agent', title: 'Synthetic reflection', content: 'A synthetic thought.', status: 'active', source: { file: join(workspace, 'source.jsonl'), sessionId: 'synthetic-source', callId: 'synthetic-origin', context: [] }, nextWake: now + (overrides.initialRestMs ?? 0), createdAt: now, updatedAt: now }; });
  return { root, config, agentDir, workspace, writeConfig: extra => { writeFileSync(path, JSON.stringify({ subconscious: { ...raw, ...extra } })); return loadConfig(path, trusted); } };
}
export async function foreground(config, factory, handler = () => output('Synthetic reply.')) {
  const manager = SessionManager.create(config.workspace, join(config.agentDir, 'sessions', 'synthetic-foreground'));
  manager.appendMessage({ role: 'user', content: [{ type: 'text', text: 'Synthetic opening.' }], timestamp: Date.now() });
  const resourceLoader = new DefaultResourceLoader({ cwd: config.workspace, agentDir: config.agentDir, extensionFactories: [factory] });
  await resourceLoader.reload();
  const result = await createAgentSession({ cwd: config.workspace, agentDir: config.agentDir, resourceLoader, sessionManager: manager });
  result.session.agent.streamFunction = fakeStream(handler);
  await result.session.bindExtensions({ mode: 'rpc', onError: error => { throw new Error(error.error); } });
  return result.session;
}
