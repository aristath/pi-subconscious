import { SettingsManager, getAgentDir } from '@earendil-works/pi-coding-agent';
import { getSupportedThinkingLevels } from '@earendil-works/pi-ai';
import { persistSession } from './native.js';

// Live-session operations only: these need Pi's ExtensionCommandContext inside
// the worker process. Static path-based session/configuration operations run
// host-side on the SDK directly (native.js).
export function registerCommands(pi, extra = {}) {
  const methods = {
    tools: () => pi.getAllTools().map(({ name, description, exposure, namespace }) => ({ name, description, exposure, namespace })),
    'session.flush': (_args, ctx) => { persistSession(ctx.sessionManager); return ctx.sessionManager.getSessionFile(); },
    settings: (_args, ctx) => { const native = SettingsManager.create(ctx.cwd, getAgentDir(), { projectTrusted: true }); return { settings: pi.getSettings(), defaults: { compaction: native.getCompactionSettings(), retry: native.getRetrySettings() }, models: ctx.modelRegistry.getAvailable().map(model => ({ provider: model.provider, id: model.id, name: model.name, contextWindow: model.contextWindow, thinkingLevels: getSupportedThinkingLevels(model) })) }; },
    ...extra,
  };
  pi.registerCommand('pi-command', { description: 'Live session and configuration operations for an RPC client', handler: async (text, ctx) => {
    const { id, method, args } = JSON.parse(text);
    try {
      if (!Object.hasOwn(methods, method)) throw new Error('Unknown Pi operation.');
      const data = await methods[method](args ?? {}, ctx);
      ctx.ui.notify('pi-rpc:' + JSON.stringify({ id, data }), 'info');
    } catch (error) { ctx.ui.notify('pi-rpc:' + JSON.stringify({ id, error: error.message }), 'info'); }
  } });
}
export default function rpcCommands(pi) { registerCommands(pi); }