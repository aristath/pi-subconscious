import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';

export const TASK_MARKER = 'pi-subconscious:task';

export const INTERNAL_TOOLS = [
  'subconscious_source',
  'subconscious_return', 'subconscious_finish', 'subconscious_start_chat',
  'subconscious_chats',
];
export const DEFAULT_TOOLS = ['read', 'ls', 'find', 'grep'];
export function expandPath(path, base = process.cwd()) {
  if (typeof path !== 'string' || !path.trim()) throw new Error('Expected a nonempty path');
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return join(homedir(), path.slice(2));
  return resolve(base, path);
}
export function defaultConfigPath() { return join(process.cwd(), '.pi', 'settings.json'); }
export function assertProfilePath(config, path) {
  if (!config.profileRoot || !path) return;
  const target = resolve(path), roots = [config.profileRoot, ...(config.sourceRoots ?? [])].map(path => resolve(path));
  const inside = (base, value) => { const part = relative(base, value); return part !== '..' && !part.startsWith('../') && !isAbsolute(part); };
  const root = roots.find(root => {
    if (inside(root, target)) return true;
    try { return inside(realpathSync(root), target); } catch { return false; }
  });
  if (!root) throw new Error('This file belongs to another profile.');
  let existing = target;
  while (!existsSync(existing) && existing !== dirname(existing)) existing = dirname(existing);
  if (!inside(realpathSync(root), realpathSync(existing))) throw new Error('This file points outside the profile.');
}
export function loadConfig(path = defaultConfigPath(), overrides = {}) {
  const configPath = expandPath(path);
  const input = existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf8')) : {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Configuration must be a JSON object');
  const base = dirname(dirname(configPath));
  const agentDir = expandPath(overrides.agentDir ?? process.env.PI_CODING_AGENT_DIR ?? join(homedir(), '.pi/agent'), base);
  const raw = { ...(overrides.settings?.subconscious ?? input.subconscious), ...overrides };
  let dataDir = expandPath(raw.dataDir ?? './subconscious', base);
  // Existing symlink aliases must share a coordinator.
  if (existsSync(dataDir)) dataDir = realpathSync(dataDir);
  const config = {
    configPath, dataDir,
    workspace: base,
    agentDir,
    profileRoot: base, sourceRoots: [],
    executionCwd: expandPath(raw.cwd ?? base, base),
    piCommand: raw.piCommand ?? 'pi',
    initiallyPaused: raw.initiallyPaused === true,
    errorRetryMs: raw.errorRetryMs ?? 30000,
    allowedTools: raw.allowedTools ?? DEFAULT_TOOLS,
  };
  assertProfilePath(config, dataDir);
  if (!Number.isFinite(config.errorRetryMs) || config.errorRetryMs < 0) throw new Error('errorRetryMs must be a nonnegative finite number');
  if (!Array.isArray(config.allowedTools) || config.allowedTools.some(t => typeof t !== 'string' || !/^[\w.-]+$/.test(t))) throw new Error('allowedTools must contain exact tool names, without wildcards');
  config.storeId = createHash('sha256').update(dataDir).digest('hex');
  config.socketPath = process.platform === 'win32'
    ? `\\\\.\\pipe\\pi-subconscious-${config.storeId.slice(0, 24)}`
    : join(dataDir, 'service.sock');
  if (process.platform !== 'win32' && Buffer.byteLength(config.socketPath) > 100) throw new Error('dataDir is too long for a local socket; choose a shorter path');
  return config;
}
