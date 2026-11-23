// Host-side native operations. Pi's own SDK classes own the session format,
// settings merge and model catalog; no Pi child process or command round-trip
// is involved for static session/configuration reads and writes.
import { SessionManager, SettingsManager, ModelRuntime, ModelRegistry, getAgentDir } from '@earendil-works/pi-coding-agent';
import { getSupportedThinkingLevels } from '@earendil-works/pi-ai';
import { openSync, fsyncSync, closeSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { nativeOperations } from './native-operations.js';

export function syncSession(manager) {
  const path = typeof manager === 'string' ? manager : manager.getSessionFile();
  if (path && existsSync(path)) { const fd = openSync(path, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } }
}
export function persistSession(manager) {
  const path = manager.getSessionFile();
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, [manager.getHeader(), ...manager.getEntries()].map(row => JSON.stringify(row)).join('\n') + '\n', { flag: 'wx', mode: 0o600 });
  }
  syncSession(manager);
}
export function sessionData(manager) {
  return { header: manager.getHeader(), entries: manager.getEntries(), branch: manager.getBranch(), leafId: manager.getLeafId(), messages: manager.buildSessionContext().messages };
}

export function nativeMethods(extra = {}) {
  return {
    'sessions.list': ({ directory }) => SessionManager.listAll(directory),
    'session.header': ({ path }) => SessionManager.open(path).getHeader(),
    'session.entries': ({ path }) => SessionManager.open(path).getEntries(),
    'session.messages': ({ path }) => SessionManager.open(path).buildSessionContext().messages,
    'session.read': ({ path }) => sessionData(SessionManager.open(path)),
    'session.rename': ({ path, name }) => { const manager = SessionManager.open(path); manager.appendSessionInfo(name); syncSession(manager); },
    'session.archive': ({ path, data }) => { const manager = SessionManager.open(path); manager.appendCustomEntry('pi-session-archive:state', data); syncSession(manager); },
    'session.copy': ({ path, entryId, directory, cwd }) => {
      const manager = SessionManager.open(path);
      if (entryId === undefined) entryId = manager.getLeafId();
      if (entryId) manager.createBranchedSession(entryId);
      else { const empty = SessionManager.create(cwd ?? manager.getCwd(), directory ?? manager.getSessionDir()); empty.getHeader().parentSession = path; persistSession(empty); return empty.getSessionFile(); }
      persistSession(manager); return manager.getSessionFile();
    },
    ...nativeOperations(persistSession),
    ...extra,
  };
}

const methods = nativeMethods();
// One-shot host-side request. `settings` reads the merged settings and the
// native model catalog; every other method is a pure SessionManager operation.
export async function piRequest(config, method, args = {}) {
  if (method === 'settings') {
    const cwd = config.workspace ?? config.cwd ?? process.cwd();
    const agentDir = config.agentDir ?? getAgentDir();
    const native = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
    const runtime = await ModelRuntime.create({ authPath: join(agentDir, 'auth.json'), modelsPath: join(agentDir, 'models.json'), allowModelNetwork: false });
    const models = new ModelRegistry(runtime).getAvailable().map(model => ({ provider: model.provider, id: model.id, name: model.name, contextWindow: model.contextWindow, thinkingLevels: getSupportedThinkingLevels(model) }));
    return { settings: native.getSettings(), defaults: { compaction: native.getCompactionSettings(), retry: native.getRetrySettings() }, models };
  }
  if (!Object.hasOwn(methods, method)) throw new Error('Unknown Pi operation.');
  return methods[method](args ?? {});
}