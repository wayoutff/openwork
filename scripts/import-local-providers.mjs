import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

// Credentials stay in memory or private application state, never in repo files.
const apply = process.argv.includes('--apply');
const sourcePort = Number(process.env.OPENWORK_SOURCE_CDP_PORT || 9224);
const targetPort = Number(process.env.OPENWORK_DEV_CDP_PORT || 9225);
if (sourcePort === targetPort) throw new Error('Source and target must differ');

async function renderer(port, development) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`);
  const pages = await response.json();
  const page = pages.find((entry) => entry.type === 'page' && (development
    ? /^http:\/\/(localhost|127\.0\.0\.1):\d+\//.test(entry.url)
    : entry.url.startsWith('file:///Applications/OpenWork.app/')));
  if (!page) throw new Error(development ? 'Dev OpenWork window not found' : 'Installed OpenWork window not found');
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Renderer timed out')), 10000);
      socket.onmessage = (event) => {
        const message = JSON.parse(event.data);
        if (message.id !== 1) return;
        clearTimeout(timer);
        if (message.error || message.result?.exceptionDetails) return reject(new Error('Renderer read failed'));
        resolve(message.result.result.value);
      };
      socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: {
        expression: `({base:localStorage.getItem('openwork.server.urlOverride'),token:localStorage.getItem('openwork.server.token'),host:localStorage.getItem('openwork.server.hostToken'),defaultModel:localStorage.getItem('openwork.defaultModel')})`,
        returnByValue: true,
      } }));
    });
  } finally { socket.close(); }
}

function client(connection) {
  const url = new URL(connection.base);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname)) {
    throw new Error('Only local OpenWork servers are allowed');
  }
  return async (route, method = 'GET', body) => {
    const response = await fetch(new URL(route, url), {
      method,
      headers: { Authorization: `Bearer ${connection.token}`, 'X-OpenWork-Host-Token': connection.host, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(60000),
    });
    if (!response.ok) throw new Error(`Local API ${method} ${route}: HTTP ${response.status}`);
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  };
}

try {
  const source = await renderer(sourcePort, false);
  const target = await renderer(targetPort, true);
  if (source.base === target.base) throw new Error('Refusing to copy within the same server');
  const from = client(source);
  const to = client(target);
  const original = await from('/runtime-config/providers');
  const before = await to('/runtime-config/providers');
  const workspaces = await to('/workspaces');
  const workspace = workspaces.workspaces?.[0] ?? workspaces[0];
  if (!workspace?.id) throw new Error('Dev workspace not available');
  const auth = JSON.parse(await readFile(path.join(homedir(), '.local/share/opencode/auth.json'), 'utf8'));
  const providers = Object.fromEntries(Object.entries(original.provider ?? {}).filter(([id, definition]) =>
    !id.startsWith('openwork-') && definition.options?.baseURL && (auth[id]?.type === 'api' || definition.options?.apiKey)));
  const ids = Object.keys(providers);
  if (!ids.length) throw new Error('No custom API-key providers to import');
  console.log(JSON.stringify({ mode: apply ? 'apply' : 'preview', providers: ids.map((id) => ({ id, models: Object.keys(providers[id].models ?? {}) })) }, null, 2));
  if (apply) {
    const backup = path.join(homedir(), '.local/state/openwork-dev-import', new Date().toISOString().replaceAll(':', '-'));
    await mkdir(backup, { recursive: true, mode: 0o700 });
    await writeFile(path.join(backup, 'providers-before.json'), JSON.stringify(before, null, 2), { mode: 0o600, flag: 'wx' });
    // Target is a fresh dev profile; refuse to overwrite existing custom entries.
    const collisions = ids.filter((id) => before.provider?.[id]);
    if (collisions.length) throw new Error('Dev already contains these provider IDs; refusing overwrite');
    await to(`/workspace/${workspace.id}/config`, 'PATCH', { opencode: { provider: providers }, mergeProviderModels: ids });
    for (const id of ids) {
      const credential = auth[id]?.type === 'api' ? auth[id] : { type: 'api', key: providers[id].options.apiKey };
      await to(`/workspace/${workspace.id}/opencode/auth/${encodeURIComponent(id)}`, 'PUT', credential);
    }
    const status = await to('/experimental/engine-v2-preview/status');
    const catalog = await to(`/workspace/${workspace.id}/opencode2/api/model`);
    console.log(JSON.stringify({ imported: ids, mirrored: status.mirroredProviderIds, engine: status.version,
      models: (catalog.data ?? []).filter((model) => ids.includes(model.providerID)).map((model) => ({ id: model.id, provider: model.providerID })),
      backup }, null, 2));
  }
} catch (error) {
  // Avoid dumping responses, request bodies or objects containing credentials.
  console.error(error instanceof Error ? error.message : 'Provider import failed');
  process.exitCode = 1;
}
