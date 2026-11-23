import { spawn as spawnChild } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const rpcExtension = fileURLToPath(new URL('./rpc-extension.js', import.meta.url));
// Transport only: Pi owns settings, sessions, extensions and the agent loop.
// A single implementation serves both short-lived one-shot requests (piRequest) and the
// long-lived web worker; Pi's own stdout events stream to onEvent.
export class PiProcess {
  constructor({ cwd = process.cwd(), command = 'pi', args = [], env = process.env, spawn = spawnChild, onEvent = () => {} } = {}) {
    this.pending = new Map(); this.onEvent = onEvent; this.inputTail = Promise.resolve();
    this.child = spawn(command, ['--mode', 'rpc', ...args], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let diagnostic = '';
    this.child.stderr.on('data', chunk => {
      diagnostic = (diagnostic + chunk).slice(-4096);
      this.onEvent({ type: 'diagnostic', message: String(chunk) });
    });
    // Buffer stdout on newlines only: JSON content can carry U+2028/U+2029 line
    // separators that readline would treat as line breaks and shred the frame.
    this.child.stdout.setEncoding('utf8');
    let output = '';
    this.child.stdout.on('data', chunk => {
      output += chunk;
      let end;
      while ((end = output.indexOf('\n')) !== -1) {
        const line = output.slice(0, end).replace(/\r$/, '');
        output = output.slice(end + 1);
        if (line) this.handleLine(line);
      }
    });
    const fail = error => { for (const p of this.pending.values()) { if (p.timer) clearTimeout(p.timer); p.reject(error); } this.pending.clear(); };
    this.child.on('error', fail);
    this.exited = new Promise(resolve => this.child.once('exit', (code, signal) => { fail(new Error(`Pi exited (${signal ?? code}): ${diagnostic}`)); resolve({ code, signal }); }));
    this.child.stdin.on('error', fail);
  }
  get pid() { return this.child.pid; }
  kill(signal) { return this.child.kill(signal); }
  // Route one stdout line: resolve the matching request, or stream the event to the host.
  handleLine(line) {
    let event; try { event = JSON.parse(line); } catch { return; }
    if (event.type === 'response') {
      const pending = this.pending.get(event.id);
      if (pending) { this.pending.delete(event.id); if (pending.timer) clearTimeout(pending.timer); if (event.success) pending.resolve(event.data); else pending.reject(new Error(event.error)); return; }
    } else if (event.type === 'extension_ui_request' && event.method === 'notify' && event.message.startsWith('pi-rpc:')) {
      const reply = JSON.parse(event.message.slice(7)), pending = this.pending.get(reply.id);
      if (pending) { this.pending.delete(reply.id); if (pending.timer) clearTimeout(pending.timer); if (reply.error) pending.reject(new Error(reply.error)); else pending.resolve(reply.data); return; }
    }
    this.onEvent(event);
  }
  // Serialize stdin writes so concurrent requests cannot interleave a single line on the wire.
  write(record) {
    const child = this.child;
    this.inputTail = this.inputTail.catch(() => {}).then(() => new Promise((resolve, reject) => {
      if (!child || child.stdin.destroyed) return reject(new Error('Pi is disconnected.'));
      child.stdin.write(JSON.stringify(record) + '\n', error => error ? reject(error) : resolve());
    }));
    return this.inputTail;
  }
  send(data) { return this.write(data); }
  request(type, data = {}, { timeout } = {}) {
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      let timer;
      if (timeout) timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Pi did not respond to ${type}.`)); }, timeout);
      timer?.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      this.write({ id, type, ...data }).catch(error => { if (timer) clearTimeout(timer); this.pending.delete(id); reject(error); });
    });
  }
  async invoke(method, args = {}) {
    const { commands } = await this.request('get_commands');
    if (!commands.some(command => command.name === 'pi-command')) throw new Error('The native Pi command extension failed to load.');
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.request('prompt', { message: '/pi-command ' + JSON.stringify({ id, method, args }) }).catch(error => { this.pending.delete(id); reject(error); });
    });
  }
  async close() { this.child.stdin.end(); await this.exited; }
}
export async function piRequest(config, method, args = {}) {
  const peer = new PiProcess({ cwd: config.workspace ?? config.cwd, command: config.piCommand ?? 'pi',
    args: ['--no-session', '--no-extensions', '--offline', '--approve', '-e', rpcExtension],
    env: { ...process.env, ...(config.agentDir ? { PI_CODING_AGENT_DIR: config.agentDir } : {}) } });
  try { await peer.request('get_state'); return await peer.invoke(method, args); }
  finally { await peer.close(); }
}
