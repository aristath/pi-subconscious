import { request } from 'node:http';
import { loadConfig } from './config.js';

export class Client {
  constructor(config) { this.config = typeof config === 'string' || config === undefined ? loadConfig(config) : config; }
  call(method, params = {}, options = {}) {
    return new Promise((resolve, reject) => {
      const body = JSON.stringify({ method, params });
      const req = request({ socketPath: this.config.socketPath, path: '/', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, response => {
        let data = '';
        response.setEncoding('utf8');
        response.on('data', chunk => { data += chunk; });
        response.on('end', () => {
          try { const value = JSON.parse(data); value.error ? reject(new Error(value.error)) : resolve(value.result); }
          catch (error) { reject(error); }
        });
      });
      req.on('error', reject);
      if (options.timeout !== 0) req.setTimeout(options.timeout ?? 10000, () => req.destroy(new Error('Coordinator request timed out')));
      const abort = () => req.destroy(new Error('Request aborted'));
      options.signal?.addEventListener('abort', abort, { once: true });
      req.once('close', () => options.signal?.removeEventListener('abort', abort));
      if (options.signal?.aborted) abort();
      req.end(body);
    });
  }
  // The host application owns the coordinator's lifetime. This only checks
  // that it is reachable; it never starts a competing process.
  async ensure() {
    try { await this.call('ping'); return; }
    catch (error) {
      if (['ENOENT', 'ECONNREFUSED'].includes(error.code)) throw new Error('The reflection coordinator is managed by the host application and is not running.');
      throw error;
    }
  }
  async connect() { await this.ensure(); return this; }
}
