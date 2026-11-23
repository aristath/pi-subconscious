#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from './client.js';
import { loadConfig } from './config.js';
import { piRequest } from './native.js';
import { dirname } from 'node:path';
import { durableWrite } from './store.js';

export async function main(argv = process.argv.slice(2)) {
  const args = [...argv];
  const take = name => {
    const index = args.indexOf(name);
    if (index < 0) return undefined;
    const value = args[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${name} needs a value`);
    args.splice(index, 2); return value;
  };
  const path = take('--config'), agentDir = take('--agent-dir');
  const initial = loadConfig(path, { agentDir });
  const { settings } = await piRequest({ workspace: initial.workspace, agentDir: initial.agentDir, piCommand: initial.piCommand }, 'settings');
  const config = loadConfig(path, { agentDir, settings });
  const command = args.shift() ?? 'status';
  if (command === 'help' || command === '--help') {
    console.log('pi-subconscious [--config PATH] init|start|serve|stop|status|pause|resume|list|read ID [OFFSET]|actions|resolve JSON|notifications|ack ID|unregister CLIENT_ID');
    return;
  }
  if (command === 'init') {
    const document = readable(config.configPath) ? JSON.parse(readFileSync(config.configPath, 'utf8')) : {};
    if (document.subconscious) throw new Error('subconscious is already configured in Pi settings');
    document.subconscious = { dataDir: './subconscious', initiallyPaused: true, allowedTools: config.allowedTools };
    durableWrite(config.configPath, JSON.stringify(document, null, 2) + '\n');
    console.log(`Created ${config.configPath}`); return;
  }
  if (command === 'serve') {
    const { startService } = await import('./service.js');
    const service = await startService(config);
    const stop = () => void service.close().catch(error => { console.error(error.message); process.exitCode = 1; });
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    return service;
  }
  const client = new Client(config);
  if (command === 'start') { await client.ensure(); console.log('Coordinator running'); return; }
  let method = command, params = {};
  if (command === 'pause' || command === 'resume') { method = 'pause'; params.paused = command === 'pause'; }
  else if (command === 'read') params = { id: args[0], offset: Number(args[1] ?? 0) };
  else if (command === 'resolve') params = JSON.parse(args.join(' '));
  else if (command === 'ack') { method = 'notification.ack'; params.id = args[0]; }
  else if (command === 'unregister') { method = 'foreground.leave'; params.id = args[0]; }
  else if (!['status', 'stop', 'list', 'actions', 'notifications'].includes(command)) throw new Error('Unknown command; use help');
  console.log(JSON.stringify(await client.call(method, params), null, 2));
}
function readable(path) { try { readFileSync(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
