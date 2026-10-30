import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./den-local.mjs', import.meta.url));
const root = path.resolve(path.dirname(script), '..');
const children = [];
let stopping = false;
const abort = new AbortController();
function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  abort.abort();
  process.exitCode = code;
  for (const child of [...children].reverse()) child.kill('SIGTERM');
}
process.on('SIGINT', () => shutdown());
process.on('SIGTERM', () => shutdown());

function start(mode) {
  const child = spawn(process.execPath, [script, mode], { cwd: root, stdio: 'inherit' });
  children.push(child);
  child.on('error', () => { console.error(`${mode} failed to start`); shutdown(1); });
  child.on('exit', code => { if (!stopping) { console.error(`${mode} exited (${code})`); shutdown(1); } });
}
async function listening(port) {
  return new Promise(resolve => {
    const socket = createConnection({ host: '127.0.0.1', port });
    socket.setTimeout(500);
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => { socket.destroy(); resolve(false); });
    socket.once('timeout', () => { socket.destroy(); resolve(false); });
  });
}
async function waitFor(check, label) {
  const deadline = Date.now() + 180000;
  while (!stopping && Date.now() < deadline) {
    try { if (await check()) return; } catch {}
    await delay(1000, undefined, { signal: abort.signal });
  }
  throw new Error(`${label} did not become ready`);
}
try {
  for (const port of [13306, 8788, 3005]) {
    if (await listening(port)) throw new Error(`Port ${port} is already occupied; stop the existing service first`);
  }
  start('mysql');
  await waitFor(() => listening(13306), 'MySQL');
  start('api');
  await waitFor(async () => (await fetch('http://127.0.0.1:8788/health', { signal: AbortSignal.timeout(2000) })).ok, 'Den API');
  start('web');
  await waitFor(async () => (await fetch('http://127.0.0.1:3005/api/health', { signal: AbortSignal.timeout(10000) })).ok, 'Den Web');
  console.log('Personal Den ready: http://localhost:3005 (loopback only). Ctrl+C stops all three services without deleting data.');
} catch (error) {
  if (!stopping) { console.error(error instanceof Error ? error.message : 'Den stack failed'); shutdown(1); }
}
