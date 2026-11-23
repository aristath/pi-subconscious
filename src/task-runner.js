import { spawn } from 'node:child_process';
import { mkdir, realpath } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, relative, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { PiProcess } from './rpc.js';
import { acquireLock } from './service.js';
import { persistSession } from './native.js';
import { Client } from './client.js';
import { loadConfig } from './config.js';

// The application owns admission; the child owns one user's cwd and Pi runtime.
export async function runTask(task, context, control) {
  const child = spawn(process.execPath, ['--experimental-strip-types', fileURLToPath(import.meta.url)], {
    cwd: task.folder, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: { ...process.env, PI_CODING_AGENT_DIR: context.agentDir },
  });
  let failure, done = false;
  const send = message => { if (child.connected) child.send(message, () => {}); };
  child.stdout.on('data', data => process.stdout.write(data));
  child.stderr.on('data', data => process.stderr.write(data));
  child.on('message', message => {
    if (message.type === 'initialized') control.release();
    else if (message.type === 'session') {
      try { control.saveSession(message.file); send({ type: 'saved', id: message.id }); }
      catch (error) { failure = error; send({ type: 'saved', id: message.id, error: error.message }); }
    } else if (message.type === 'done') { done = true; if (message.error) failure = new Error(message.error); }
  });
  const configPath = task.mode === 'inference' ? (context.subconsciousConfig ?? join(context.executionCwd ?? context.workspace, '.pi/settings.json')) : undefined;
  const result = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      // A killed task Pi cannot release its own admitted turn; the coordinator
      // clears any step this task still holds so the queue never wedges.
      if (task.mode === 'inference') {
        void new Client(loadConfig(configPath)).call('task.cleanup', { id: `${task.user.id}/${task.name}` }).catch(() => {});
      }
      if (failure) reject(failure);
      else if (!done || code !== 0) reject(new Error(`Task worker stopped (${signal ?? code}); this occurrence will not be replayed.`));
      else resolve();
    });
  });
  send({ type: 'run', task: { ...task, user: { id: task.user.id, admin: task.user.admin } },
    executionCwd: context.executionCwd ?? context.workspace, piCommand: context.piCommand, agentDir: context.agentDir, sessionFile: control.sessionFile,
    lockDir: context.taskLockDir, configPath });
  return result;
}

async function worker(input) {
  let sequence = 0;
  const waiting = new Map();
  const controller = new AbortController();
  process.on('disconnect', () => {
    controller.abort();
    for (const pending of waiting.values()) pending.reject(new Error('Scheduler stopped'));
    waiting.clear();
  });
  process.on('message', message => {
    const reply = waiting.get(message.id);
    if (reply) { waiting.delete(message.id); if (message.error) reply.reject(new Error(message.error)); else reply.resolve(); }
  });
  const ask = message => new Promise((resolve, reject) => {
    if (!process.connected) { reject(new Error('Scheduler stopped')); return; }
    const id = String(++sequence); waiting.set(id, { resolve, reject });
    process.send({ ...message, id });
  });
  let peer, releaseLock;
  try {
    if (input.lockDir) releaseLock = acquireLock({ dataDir: input.lockDir });
    const task = await import(pathToFileURL(input.task.path));
    if (input.task.mode === 'deterministic') {
      if (typeof task.default !== 'function') throw new Error('A deterministic task must export a default function.');
      await task.default({ cwd: input.task.folder, user: input.task.user.id, signal: controller.signal });
      return;
    }
    const prompt = typeof task.default === 'function'
      ? await task.default({ cwd: input.task.folder, user: input.task.user.id, signal: controller.signal }) : task.default;
    if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('An inference task must export a prompt string or a function returning one.');
    if (input.sessionFile && !existsSync(input.sessionFile)) throw new Error('This task’s continued conversation is unavailable; restore it or select @session fresh.');
    const root = await realpath(input.task.folder);
    const check = path => { const part = relative(root, path); if (part === '..' || part.startsWith('../') || isAbsolute(part)) throw new Error('The task conversation belongs to another profile.'); };
    let directory = await realpath(join(root, 'tasks'));
    check(directory);
    for (const name of ['.sessions', input.task.name]) {
      directory = join(directory, name);
      try { await mkdir(directory, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
      directory = await realpath(directory); check(directory);
    }
    const previous = input.sessionFile && await realpath(input.sessionFile);
    if (previous) check(previous);
    // Persist the task session host-side before Pi opens it: the file exists
    // with its header, so --session reopens exactly this conversation.
    const file = previous ?? (() => {
      const manager = SessionManager.create(input.executionCwd, directory);
      persistSession(manager); return manager.getSessionFile();
    })();
    let settle, failure;
    const settled = new Promise(resolve => { settle = resolve; });
    peer = new PiProcess({ cwd: input.executionCwd, command: input.piCommand ?? 'pi',
      args: ['--approve', '--session-dir', directory, '--session', file, ...(input.task.model ? ['--model', input.task.model] : []), ...(input.task.thinking ? ['--thinking', input.task.thinking] : []),
        ...(input.task.tools ? ['--tools', input.task.tools] : []), ...(input.task.exclude_tools ? ['--exclude-tools', input.task.exclude_tools] : []),
        ...(input.task.soul === 'none' ? ['--soul', 'none'] : []),
        '-e', fileURLToPath(new URL('./task-runtime.js', import.meta.url)), '--scheduled-task', input.task.path,
        '--task-owner', input.task.user.id, '--task-name', input.task.name, ...(input.configPath ? ['--subconscious-config', input.configPath] : [])],
      env: { ...process.env, PI_CODING_AGENT_DIR: input.agentDir }, onEvent: event => {
        if (event.type === 'agent_settled') settle();
        if (event.type === 'extension_error') failure = new Error(event.error);
      } });
    await peer.request('get_state');
    await ask({ type: 'session', file });
    process.send({ type: 'initialized' });
    const { commands } = await peer.request('get_commands');
    if (!commands.some(command => command.name === 'task-run')) throw new Error('The task extension failed to load.');
    await peer.request('prompt', { message: `/task-run ${JSON.stringify({ prompt, owner: { id: input.task.user.id, cwd: input.task.folder, task: input.task.name } })}` });
    await Promise.race([settled, peer.exited.then(() => { throw new Error('Task Pi stopped before settling.'); })]);
    if (failure) throw failure;
    const { messages } = await peer.request('get_messages'), last = messages.findLast(message => message.role === 'assistant');
    if (['error', 'aborted'].includes(last?.stopReason)) throw new Error(last.errorMessage ?? 'Task inference did not finish');
  } finally {
    if (peer) await peer.close();
    releaseLock?.();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.once('message', input => {
    const finish = error => {
      const code = error ? 1 : 0;
      if (process.connected) process.send({ type: 'done', ...(error ? { error: error.message } : {}) }, () => process.exit(code));
      else process.exit(code);
    };
    void worker(input).then(() => finish(), finish);
  });
}
