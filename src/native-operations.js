// Static session operations on Pi's own SDK classes. They run host-side in the
// embedding application and inside Pi processes alike; Pi owns the format.
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { existsSync, realpathSync } from 'node:fs';
import { PRIVATE_MARKER, RETURN_TYPE } from './private-extension.js';
import { INTERNAL_TOOLS } from './config.js';

export function originContext(manager, callId) {
  const projection = manager.buildSessionProjection().entries;
  const index = projection.findLastIndex(entry => entry.messages.some(message => message.role === 'assistant' && message.content.some(part => part.type === 'toolCall' && part.id === callId && part.name === 'subconscious_reflect')));
  if (index < 0) throw new Error('The originating Pi tool invocation is unavailable');
  const entry = projection[index], message = entry.messages.find(message => message.role === 'assistant' && message.content.some(part => part.type === 'toolCall' && part.id === callId));
  const call = message.content.find(part => part.type === 'toolCall' && part.id === callId);
  return { file: realpathSync(manager.getSessionFile()), sessionId: manager.getSessionId(), callId, entryId: entry.sourceEntry.id, cwd: manager.getCwd(),
    context: [...projection.slice(0, index).flatMap(entry => entry.messages).filter(message => message.role !== 'system').slice(-2), message], thought: call.arguments.content };
}
export function originPresent(manager, source) {
  const branch = manager.getBranch(), entry = branch.find(entry => entry.id === source.entryId);
  if (entry?.type !== 'message' || entry.message.role !== 'assistant') return false;
  const edit = branch.findLast(entry => entry.type === 'context_edit' && entry.targetId === source.entryId), content = edit ? edit.replacement?.content : entry.message.content;
  return Array.isArray(content) && content.some(part => part.type === 'toolCall' && part.id === source.callId && part.name === 'subconscious_reflect' && part.arguments.content === source.thought);
}
export const deliveredIds = manager => new Set(manager.getBranch().filter(entry => entry.type === 'custom_message' && entry.customType === RETURN_TYPE).flatMap(entry => entry.details?.deliveryIds ?? []));
export const assistantMessage = (text, model) => ({ role: 'assistant', content: [{ type: 'text', text }], api: model.api, provider: model.provider, model: model.id,
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop', timestamp: Date.now() });

export function nativeOperations(persist) {
  return {
    'source.context': ({ path, callId }) => originContext(SessionManager.open(path), callId),
    'source.deliveries': ({ path, sessionId, deliveries }) => {
      const manager = SessionManager.open(path);
      if (manager.getSessionId() !== sessionId) throw new Error('The source session identity changed.');
      const received = deliveredIds(manager);
      return deliveries.map(row => ({ id: row.id, received: received.has(row.id), present: originPresent(manager, row.source) }));
    },
    'private.prepare': ({ row, directory, cwd, storeId, actions, receipts }) => {
      if (row.sessionFile && !existsSync(row.sessionFile) && (row.transcriptCommitted || Object.keys(actions).length)) throw new Error('The private transcript is unavailable; accepted work is preserved.');
      const manager = row.sessionFile ? SessionManager.open(row.sessionFile) : SessionManager.create(cwd, directory);
      if (row.sessionId && manager.getSessionId() !== row.sessionId) throw new Error('Private transcript identity changed.');
      if (!row.sessionId) { manager.appendCustomEntry(PRIVATE_MARKER, { version: 1, storeId, conversationId: row.id, kind: row.kind }); manager.appendSessionInfo(row.title); }
      const entries = manager.getBranch(), assistantIndex = entries.findLastIndex(e => e.type === 'message' && e.message.role === 'assistant');
      if (assistantIndex >= 0) {
        const assistant = entries[assistantIndex], results = new Map(entries.slice(assistantIndex + 1).filter(e => e.type === 'message' && e.message.role === 'toolResult').map(e => [e.message.toolCallId, e.message]));
        for (const call of assistant.message.content.filter(p => p.type === 'toolCall')) {
          const key = `${manager.getSessionId()}:${assistant.id}:${call.id}`, action = actions[key];
          if (results.has(call.id)) { if (action) Object.assign(action, { status: 'completed', result: results.get(call.id) }); continue; }
          let result = action?.status === 'completed' ? action.result : undefined;
          if (!result && receipts[key]) result = { content: [{ type: 'text', text: JSON.stringify(receipts[key]) }], details: receipts[key] };
          if (!result && action?.status === 'started' && !INTERNAL_TOOLS.includes(call.name)) {
            row.blocked = `Unknown outcome for ${call.name} (${call.id}). Inspect and resolve the action before continuing.`; row.blockedAction = key; break;
          }
          result ??= { content: [{ type: 'text', text: 'This call did not commit before shutdown. It was not replayed; request it again if still wanted.' }], isError: true };
          result = { role: 'toolResult', toolCallId: call.id, toolName: call.name, timestamp: Date.now(), ...result };
          if (action) Object.assign(action, { status: 'completed', result });
          manager.appendMessage(result);
        }
      }
      if (row.blockedAction && actions[row.blockedAction]?.status === 'completed') { delete row.blocked; delete row.blockedAction; }
      persist(manager);
      return { file: manager.getSessionFile(), sessionId: manager.getSessionId(), actions, blocked: row.blocked, blockedAction: row.blockedAction, branch: manager.getBranch() };
    },
    'chat.create': ({ path, cwd, directory, title, message, model, key }) => {
      const manager = path ? SessionManager.open(path) : SessionManager.create(cwd, directory);
      if (message && !manager.getEntries().some(e => e.type === 'custom' && e.customType === 'pi-subconscious:opening' && e.data?.receipt === key)) {
        manager.appendCustomEntry('pi-subconscious:opening', { receipt: key }); manager.appendSessionInfo(title); manager.appendMessage(assistantMessage(message, model));
      }
      persist(manager); return { file: manager.getSessionFile(), sessionId: manager.getSessionId(), title };
    },
  };
}
