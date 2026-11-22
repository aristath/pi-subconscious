export class Gate {
  constructor(paused = () => false, isAlive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }, now = Date.now) {
    this.paused = paused; this.isAlive = isAlive;
    this.now = now; this.lastForegroundEnd = now();
    this.clients = new Map(); this.waiters = new Set(); this.jobs = []; this.active = null; this.stopping = false;
  }
  wake() { for (const resolve of this.waiters) resolve(); this.waiters.clear(); }
  wait(signal) {
    if (signal?.aborted || this.stopping) return Promise.reject(new Error('Service stopping'));
    return new Promise((resolve, reject) => {
      const finish = () => { cleanup(); resolve(); };
      const abort = () => { cleanup(); reject(new Error('Service stopping')); };
      const cleanup = () => { this.waiters.delete(finish); signal?.removeEventListener('abort', abort); };
      this.waiters.add(finish); signal?.addEventListener('abort', abort, { once: true });
    });
  }
  update(id, data) {
    if (!id || !Number.isInteger(data.pid) || data.pid <= 0) throw new Error('Invalid foreground registration');
    if (this.clients.get(id)?.busy && data.busy === false) this.lastForegroundEnd = this.now();
    this.clients.set(id, { ...this.clients.get(id), ...data, seen: Date.now() });
    this.wake();
  }
  remove(id) { if (this.clients.get(id)?.busy) this.lastForegroundEnd = this.now(); this.clients.delete(id); this.wake(); }
  sweep(staleMs) {
    for (const [id, client] of this.clients) {
      // A live process with a lost heartbeat may still be generating. Retain its
      // busy claim; inspection/explicit unregister can resolve a stale live host.
      if (Date.now() - client.seen > staleMs && !this.isAlive(client.pid)) this.remove(id);
    }
    this.wake();
  }
  busy() { return [...this.clients.values()].some(client => client.busy); }
  async background(id, work, signal) {
    const job = { id };
    this.jobs.push(job);
    try {
      while (this.jobs[0] !== job) await this.wait(signal);
      if (this.stopping || signal?.aborted) throw new Error('Service stopping');
      return await work();
    } finally { this.jobs.splice(this.jobs.indexOf(job), 1); this.wake(); }
  }
  // Foreground sessions only register a busy claim; they never wait for
  // background work. Queueing concurrent inference is the model backend's
  // job, so this gate stays hardware-agnostic. The busy claim still lets
  // private steps yield to active chats before starting.
  async foreground(id, data, signal) {
    this.update(id, { ...data, busy: true });
    if (this.stopping || signal?.aborted) throw new Error('Service stopping');
  }
  async privateStep(kind, id, signal, paused = this.paused) {
    while (this.active || paused() || this.busy()) await this.wait(signal);
    if (this.stopping || signal?.aborted) throw new Error('Service stopping');
    const token = { kind, id, startedAt: Date.now() };
    this.active = token;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (this.active === token) this.active = null;
      this.wake();
    };
  }
  stop() { this.stopping = true; this.wake(); }
}
