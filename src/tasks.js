import { readFile, readdir, realpath } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { join, relative, isAbsolute } from 'node:path';
import { Gate } from './gate.js';
import { durableWrite } from './store.js';

export function interval(value) {
  const match = String(value).trim().match(/^(?:every\s+)?(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|seconds?|m|minutes?|h|hours?|d|days?|w|weeks?|months?|y|years?)$/i);
  if (!match || Number(match[1]) <= 0) throw new Error('Use an interval such as 5 minutes, 13h, or 6 months.');
  const amount = Number(match[1]), unit = match[2].toLowerCase();
  if (!Number.isFinite(amount)) throw new Error('The interval must be a finite positive number.');
  if (unit.startsWith('month') || unit === 'y' || unit.startsWith('year')) {
    if (!Number.isInteger(amount)) throw new Error('Calendar months and years must be whole numbers.');
    return { months: amount * (unit.startsWith('month') ? 1 : 12) };
  }
  const scale = unit === 'ms' || unit.startsWith('millisecond') ? 1 :
    unit.startsWith('s') ? 1000 : unit.startsWith('m') ? 60000 : unit.startsWith('h') ? 3600000 : unit.startsWith('d') ? 86400000 : 604800000;
  if (!Number.isFinite(amount * scale)) throw new Error('The interval is too large.');
  return { milliseconds: amount * scale };
}

export function nextRun(time, every) {
  if (every.milliseconds) {
    const next = time + every.milliseconds;
    if (!Number.isFinite(new Date(next).getTime())) throw new Error('The interval exceeds the supported calendar range.');
    return next;
  }
  const date = new Date(time), day = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + every.months);
  const end = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(day, end));
  if (!Number.isFinite(date.getTime())) throw new Error('The interval exceeds the supported calendar range.');
  return date.getTime();
}

export function taskHeader(source) {
  const header = source.match(/^\s*\/\*\*?([\s\S]*?)\*\//)?.[1];
  if (!header) throw new Error('Start the task file with a comment containing @every or @start_time, and @mode.');
  const fields = Object.fromEntries([...header.matchAll(/^\s*\*?\s*@([a-z_]+)\s+([^\r\n]+)/gm)].map(match => [match[1], match[2].trim()]));
  if (fields.start_time !== undefined && (!/^([01]\d|2[0-3]):[0-5]\d$/.test(fields.start_time) || fields.every !== undefined))
    throw new Error('Use @start_time HH:mm instead of @every for a daily start.');
  const schedule = fields.start_time !== undefined ? { start_time: fields.start_time } : { every: interval(fields.every) };
  if (fields.quiet_window !== undefined) {
    const quiet = interval(fields.quiet_window);
    if (!quiet.milliseconds) throw new Error('@quiet_window needs a fixed duration, such as 10m.');
    schedule.quiet_window = quiet.milliseconds;
  }
  if (!['deterministic', 'inference'].includes(fields.mode)) throw new Error('@mode must be deterministic or inference.');
  const session = fields.session ?? 'fresh';
  if (!['fresh', 'continue'].includes(session)) throw new Error('@session must be fresh or continue.');
  if (fields.model !== undefined && !/^[^\s/]+\/\S+$/.test(fields.model)) throw new Error('@model must be provider/model-id.');
  if (fields.soul !== undefined && fields.soul !== 'none') throw new Error('Use @soul none to disable SOUL loading, or omit it to use the execution profile.');
  const thinkingLevels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
  if (fields.thinking !== undefined && !thinkingLevels.includes(fields.thinking)) throw new Error('@thinking must be one of: off, minimal, low, medium, high, xhigh, max.');
  // Pi's native tool selection flags: an allowlist may add/remove from the defaults (+name/-name).
  if (fields.tools !== undefined && !/^[\w+\-]+(\s*,\s*[\w+\-]+)*$/.test(fields.tools)) throw new Error('@tools must be a comma-separated list of tool names, optionally +name/-name.');
  if (fields.exclude_tools !== undefined && !/^[\w\-]+(\s*,\s*[\w\-]+)*$/.test(fields.exclude_tools)) throw new Error('@exclude_tools must be a comma-separated list of tool names.');
  return { ...schedule, mode: fields.mode, session, ...(fields.model !== undefined ? { model: fields.model } : {}), ...(fields.soul !== undefined ? { soul: fields.soul } : {}), ...(fields.thinking !== undefined ? { thinking: fields.thinking } : {}), ...(fields.tools !== undefined ? { tools: fields.tools } : {}), ...(fields.exclude_tools !== undefined ? { exclude_tools: fields.exclude_tools } : {}) };
}

const inside = (root, path) => { const part = relative(root, path); return part !== '..' && !part.startsWith('../') && !isAbsolute(part); };

// One scheduler belongs to the host application; each profile owns its progress.
export class TaskScheduler {
  constructor({ users, prepare, execute, now = Date.now, gate = new Gate(undefined, undefined, now), timeZone, tickMs = 30000, report = console.error }) {
    this.users = users; this.prepare = prepare; this.execute = execute; this.gate = gate;
    this.tickMs = tickMs; this.now = now; this.report = report;
    if (!Number.isFinite(tickMs) || tickMs <= 0) throw new Error('tasks.tickMs must be a positive number of milliseconds.');
    this.states = new Map(); this.errors = new Map(); this.work = new Map(); this.stopping = false;
    this.clock = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  }
  get running() { return this.work.values().next().value ?? null; }
  dailyStart(time, clock, day = 0) {
    const parts = at => Object.fromEntries(this.clock.formatToParts(at).filter(p => p.type !== 'literal').map(p => [p.type, Number(p.value)]));
    const p = parts(time), [hour, minute] = clock.split(':').map(Number);
    const wall = Date.UTC(p.year, p.month - 1, p.day + day, hour, minute);
    let stamp = wall;
    for (let i = 0; i < 3; i++) {
      const local = parts(stamp);
      const next = wall - (Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second) - Math.floor(stamp / 1000) * 1000);
      if (next === stamp) break;
      stamp = next;
    }
    return stamp;
  }
  latestStart(time, clock) {
    const today = this.dailyStart(time, clock);
    return today <= time ? today : this.dailyStart(time, clock, -1);
  }
  quiet(task) { return task.quiet_window === undefined || this.now() - this.gate.lastForegroundEnd >= task.quiet_window; }
  state(folder) {
    if (!this.states.has(folder)) {
      const path = join(folder, '.pi/runtime/tasks.json');
      const value = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { tasks: {} };
      if (!value.tasks || typeof value.tasks !== 'object' || Array.isArray(value.tasks)) throw new Error('Task progress is unreadable; its existing file has been preserved.');
      this.states.set(folder, { path, value });
    }
    return this.states.get(folder);
  }
  save(folder) { const state = this.state(folder); durableWrite(state.path, JSON.stringify(state.value, null, 2) + '\n'); }
  error(key, error) {
    if (this.errors.get(key) !== error.message) this.report(`Scheduled task ${key}: ${error.message}`);
    this.errors.set(key, error.message);
  }
  async definition(user, name) {
    if (typeof name !== 'string' || !/^[^/\\]+\.(?:js|ts)$/.test(name)) throw new Error('Supply a task filename ending in .js or .ts.');
    const root = await realpath(user.folder), path = await realpath(join(root, 'tasks', name));
    if (!inside(root, path)) throw new Error('Task file points outside its owner’s profile.');
    return { ...taskHeader(await readFile(path, 'utf8')), user, folder: user.folder, name, path };
  }
  async request(userId, name, key) {
    if (this.stopping) throw new Error('The task runner is stopping.');
    if (typeof key !== 'string' || !key) throw new Error('A task invocation receipt is required.');
    const user = (await this.users()).find(user => user.id === userId);
    if (!user) throw new Error('Task owner is unavailable.');
    const state = this.state(user.folder).value;
    if (!Object.hasOwn(state.requests ?? {}, key)) {
      await this.definition(user, name);
      if (!Object.hasOwn(state.requests ?? {}, key)) {
        state.tasks[name] ??= { createdAt: this.now() };
        (state.requests ??= {})[key] = { name, queuedAt: this.now() };
        try { this.save(user.folder); }
        catch (error) { delete state.requests[key]; throw error; }
      }
    }
    const request = state.requests[key];
    if (request.startedAt === undefined) {
      const task = await this.definition(user, request.name);
      this.submit({ ...task, request: key, due: request.queuedAt });
    }
    return { id: key, task: request.name, status: request.startedAt === undefined ? 'queued' : 'started' };
  }
  submit(task) {
    if (this.stopping || (task.request && this.state(task.folder).value.requests[task.request].startedAt !== undefined)) return Promise.resolve();
    const key = JSON.stringify([task.user.id, task.name, task.request]);
    if (this.work.has(key)) return this.work.get(key);
    const work = this.gate.background(task.user.id+'/'+task.name, () => this.run(task))
      .catch(error => { if (!this.stopping) this.error(task.user.id+'/'+task.name, error); })
      .finally(() => this.work.delete(key));
    this.work.set(key, work);
    return work;
  }
  async pending() {
    const pending = [];
    for (const user of await this.users()) {
      const folder = user.folder;
      try {
        const directory = join(folder, 'tasks');
        let files;
        try { files = await readdir(directory, { withFileTypes: true }); }
        catch (error) { if (error.code === 'ENOENT') continue; throw error; }
        const state = this.state(folder);
        let changed = false;
        for (const file of files.sort((a,b) => a.name.localeCompare(b.name))) {
          if (!file.isFile() || !/\.(?:js|ts)$/.test(file.name)) continue;
          const key = user.id + '/' + file.name;
          try {
            const task = await this.definition(user, file.name);
            let row = state.value.tasks[file.name];
            if (!row) { row = state.value.tasks[file.name] = { createdAt: this.now() }; changed = true; }
            if (task.start_time !== undefined) {
              const due = Math.max(this.latestStart(this.now(), task.start_time), this.dailyStart(row.createdAt, task.start_time));
              const next = row.lastStarted >= due ? this.dailyStart(due, task.start_time, 1) : due;
              if (row.nextRun !== next || row.start_time !== task.start_time || row.every !== undefined) {
                row.nextRun = next; row.start_time = task.start_time; delete row.every; changed = true;
              }
            } else if (row.nextRun === undefined || row.start_time !== undefined || JSON.stringify(row.every) !== JSON.stringify(task.every)) {
              delete row.start_time;
              row.every = task.every; row.nextRun = nextRun(row.lastStarted ?? row.createdAt, task.every); changed = true;
            }
            this.errors.delete(key);
            if (row.nextRun <= this.now() && this.quiet(task)) pending.push({ ...task, due: row.nextRun });
            for (const [key, request] of Object.entries(state.value.requests ?? {})) {
              if (request.name === file.name && request.startedAt === undefined) pending.push({ ...task, request: key, due: request.queuedAt });
            }
          } catch (error) { this.error(key, error); }
        }
        // Deleting a task removes only its schedule. Its conversations remain.
        const names = new Set(files.map(file => file.name));
        for (const name of Object.keys(state.value.tasks)) if (!names.has(name)) { delete state.value.tasks[name]; changed = true; }
        if (changed) this.save(folder);
      } catch (error) { this.error(user.id, error); }
    }
    return pending.sort((a,b) => a.due - b.due || (a.user.id+'/'+a.name).localeCompare(b.user.id+'/'+b.name));
  }
  async tick() {
    if (this.running || this.stopping || this.gate.busy()) return false;
    const task = (await this.pending())[0];
    if (!task || this.running || this.stopping) return false;
    await this.submit(task);
    return true;
  }
  async run(task) {
    let release;
    try {
      release = await this.gate.privateStep('task', task.user.id+'/'+task.name);
      if (!task.request && !this.quiet(task)) return;
      const state = this.state(task.folder).value, row = state.tasks[task.name];
      // Record the occurrence before executing user code. A service crash does
      // not replay already-started deterministic effects.
      if (task.request) state.requests[task.request].startedAt = this.now();
      else {
        row.lastStarted = this.now();
        row.nextRun = task.start_time !== undefined
          ? this.dailyStart(this.latestStart(row.lastStarted, task.start_time), task.start_time, 1)
          : nextRun(row.lastStarted, task.every);
      }
      this.save(task.folder);
      const context = await this.prepare(task.user);
      if (this.stopping) return;
      await this.execute(task, context, {
        gate: this.gate,
        release: () => { release?.(); release = undefined; },
        sessionFile: task.session === 'continue' ? row.sessionFile : undefined,
        saveSession: file => { row.sessionFile = file; this.save(task.folder); },
      });
      this.errors.delete(task.user.id+'/'+task.name);
    } catch (error) { if (!this.stopping) this.error(task.user.id+'/'+task.name, error); }
    finally { release?.(); }
  }
  start() {
    const pump = async () => {
      if (this.stopping) return;
      try { await this.tick(); } catch (error) { this.error('scheduler', error); }
      if (!this.stopping) this.timer = setTimeout(pump, this.tickMs);
    };
    // Restore accepted manual requests before starting the timed schedule checks.
    this.starting = this.pending().then(tasks => {
      for (const task of tasks) if (task.request) this.submit(task);
    }).catch(error => this.error('scheduler', error)).finally(() => {
      if (!this.stopping) this.timer = setTimeout(pump, 0);
    });
  }
  async close() {
    this.stopping = true; clearTimeout(this.timer); this.gate.stop();
    await this.starting;
    await Promise.all(this.work.values());
  }
}
