import { readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';

const config = JSON.parse(await readFile(path.join(homedir(), '.local/share/openwork-personal-den/private.json'), 'utf8'));
const origin = 'http://localhost:3005';
async function request(route, body, token) {
  const r = await fetch(`http://127.0.0.1:8788${route}`, {
    method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', Origin: origin, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30000),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(`${route}: HTTP ${r.status}, code ${data.code ?? data.error ?? 'unknown'}`);
  return data;
}
try {
  const status = await request('/v1/auth/bootstrap/status');
  let session;
  if (status.status === 'available') {
    if (config.ownerPassword.length > 48) {
      config.ownerPassword = randomBytes(24).toString('base64url');
      await writeFile(path.join(homedir(), '.local/share/openwork-personal-den/private.json'), JSON.stringify(config, null, 2), { mode: 0o600 });
    }
    const verified = await request('/v1/auth/bootstrap/verify', { email: config.ownerEmail, code: config.setupCode });
    session = await request('/api/auth/sign-up/email', { email: config.ownerEmail, name: 'Local Owner', password: config.ownerPassword, bootstrapGrant: verified.grant });
  } else if (status.status === 'complete') {
    session = await request('/api/auth/sign-in/email', { email: config.ownerEmail, password: config.ownerPassword });
  } else throw new Error('Local bootstrap unavailable');
  if (!session.token) throw new Error('Local session token missing');
  const handoff = await request('/v1/auth/desktop-handoff', {}, session.token);
  const port = Number(process.env.OPENWORK_SIGNED_CDP_PORT || 9225);
  const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = pages.find(p => p.type === 'page' && p.url.startsWith('http://localhost:15374/'));
  if (!page) throw new Error('Signed OpenWork Local renderer not found');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  try {
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Desktop handoff timed out; create a fresh grant before retry')), 60000);
      ws.onmessage = event => {
        const m = JSON.parse(event.data);
        if (m.id !== 1) return;
        clearTimeout(timer);
        if (m.error || m.result?.exceptionDetails) return reject(new Error('Desktop enrollment failed; credentials suppressed'));
        resolve(m.result.result.value);
      };
      ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: `(async()=>{const {exchangeHandoffAndSignIn}=await import('/src/app/lib/den-handoff.ts');const result=await exchangeHandoffAndSignIn(${JSON.stringify(handoff.grant)},{baseUrl:'http://localhost:3005',apiBaseUrl:'http://localhost:8788'});return {ok:result.ok,error:result.ok?undefined:result.error}})()`, awaitPromise: true, returnByValue: true } }));
    });
    if (!result.ok) throw new Error(`Enrollment refused: ${result.error}`);
    console.log(JSON.stringify({ enrolled: true, web: origin, api: 'http://localhost:8788', account: config.ownerEmail, credentialsStoredPrivately: true }));
  } finally { ws.close(); }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Local enrollment failed');
  process.exitCode = 1;
}
