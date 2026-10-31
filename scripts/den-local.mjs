import { spawn, spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const state = path.join(homedir(), '.local/share/openwork-personal-den');
const configPath = path.join(state, 'private.json');
const mysqlBin = '/opt/homebrew/opt/mysql@8.4/bin';
const socket = path.join(state, 'mysql.sock');
const mode = process.argv[2];
if (!['init', 'mysql', 'provision', 'migrate', 'api', 'web', 'status'].includes(mode)) {
  console.log('Usage: node scripts/den-local.mjs init|mysql|provision|migrate|api|web|status');
  process.exit(1);
}
await mkdir(state, { recursive: true, mode: 0o700 });
const secret = () => randomBytes(32).toString('hex');
if (mode === 'init') {
  try { await access(configPath); }
  catch { await writeFile(configPath, JSON.stringify({ auth: secret(), encryption: secret(), rootPassword: secret(), databasePassword: secret(), setupCode: secret(), ownerEmail: 'owner@openwork.local', ownerPassword: randomBytes(24).toString('base64url') }, null, 2), { mode: 0o600, flag: 'wx' }); }
}
const config = JSON.parse(await readFile(configPath, 'utf8'));
const databaseUrl = `mysql://openwork:${config.databasePassword}@127.0.0.1:13306/openwork_den`;
const env = {
  ...process.env, DATABASE_URL: databaseUrl, BETTER_AUTH_SECRET: config.auth,
  DEN_DB_ENCRYPTION_KEY: config.encryption, BETTER_AUTH_URL: 'http://localhost:3005',
  DEN_DEPLOYMENT: 'self_hosted', DEN_BIND_HOST: '127.0.0.1', PORT: '8788',
  DEN_BASE_URL: 'http://localhost:3005', DEN_API_BASE: 'http://127.0.0.1:8788',
  DEN_API_PUBLIC_URL: 'http://localhost:8788', DEN_AUTH_ORIGIN: 'http://localhost:3005',
  DEN_WEB_PUBLIC_ORIGIN: 'http://localhost:3005', DEN_WEB_OPENWORK_AUTH_CALLBACK_URL: 'http://localhost:3005',
  DEN_ORG_MODE: 'single_org', DEN_SINGLE_ORG_NAME: 'Personal OpenWork', DEN_SINGLE_ORG_SLUG: 'personal',
  DEN_SINGLE_ORG_ALLOW_PUBLIC_SIGNUP: 'false', DEN_SINGLE_ORG_OWNER_EMAILS: config.ownerEmail,
  DEN_INITIAL_ADMIN_BOOTSTRAP_CODE: config.setupCode, DEN_REQUIRE_EMAIL_VERIFICATION: 'false',
  DEN_FEATURE_COMPUTER_USE: 'true', DEN_FEATURE_REMOTE_COMPUTERS: 'false',
  DEN_FEATURE_COMPUTER_KEEP_FRONT: 'true',
  DEN_FEATURE_GIT_CHANGES_PANEL: 'true', DEN_FEATURE_SESSION_FILE_BROWSER: 'true',
  DEN_MCP_RESOURCE_URL: 'http://localhost:8788/mcp',
  CORS_ORIGINS: 'http://localhost:3005,http://127.0.0.1:3005,http://localhost:8788,http://localhost:15374',
  DEN_BETTER_AUTH_TRUSTED_ORIGINS: 'http://localhost:3005,http://127.0.0.1:3005,http://localhost:8788',
  PROVISIONER_MODE: 'stub', DEN_OBSERVABILITY_BACKEND: 'none', NEXT_TELEMETRY_DISABLED: '1',
  NEXT_PUBLIC_POSTHOG_KEY: '', NEXT_PUBLIC_POSTHOG_API_KEY: '',
  OPENWORK_DEV_MODE: '1', OPENWORK_DEN_DEVELOPMENT_CONDITIONS_REEXEC: '1',
  NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --conditions=development`,
};

async function run(command, args, cwd = root, overrides = {}) {
  const child = spawn(command, args, { cwd, env: { ...env, ...overrides }, stdio: 'inherit' });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); });
  process.exitCode = code ?? 1;
}
if (mode === 'init') {
  try { await access(path.join(state, 'mysql-data')); console.log('Existing database directory preserved.'); }
  catch {
    await run(path.join(mysqlBin, 'mysqld'), ['--no-defaults', '--initialize-insecure', `--datadir=${state}/mysql-data`, `--log-error=${state}/mysql-init.log`]);
  }
  console.log('Private configuration prepared outside the repository. No credentials printed.');
} else if (mode === 'mysql') {
  const provisioned = await access(path.join(state, 'provisioned')).then(() => true, () => false);
  await run(path.join(mysqlBin, 'mysqld'), ['--no-defaults', `--datadir=${state}/mysql-data`, `--socket=${socket}`, `--pid-file=${state}/mysql.pid`, `--log-error=${state}/mysql.log`, '--bind-address=127.0.0.1', '--port=13306', '--mysqlx=OFF', '--performance-schema=OFF', '--innodb-buffer-pool-size=128M', ...(!provisioned ? ['--skip-networking'] : [])]);
} else if (mode === 'provision') {
  try { await access(path.join(state, 'provisioned')); console.log('Already provisioned; unchanged.'); }
  catch {
    const sql = `CREATE DATABASE IF NOT EXISTS openwork_den; CREATE USER IF NOT EXISTS 'openwork'@'127.0.0.1' IDENTIFIED BY '${config.databasePassword}'; GRANT ALL PRIVILEGES ON openwork_den.* TO 'openwork'@'127.0.0.1'; ALTER USER 'root'@'localhost' IDENTIFIED BY '${config.rootPassword}';`;
    const result = spawnSync(path.join(mysqlBin, 'mysql'), ['--no-defaults', '--protocol=SOCKET', `--socket=${socket}`, '-u', 'root'], { input: sql, encoding: 'utf8' });
    if (result.status !== 0) throw new Error('Database provisioning failed; no credentials logged');
    await writeFile(path.join(state, 'provisioned'), '1\n', { mode: 0o600, flag: 'wx' });
    console.log('Database provisioned. Restart mysql to enable loopback TCP.');
  }
} else if (mode === 'migrate') {
  await run('corepack', ['pnpm', 'exec', 'tsx', 'dist/scripts/bootstrap.js'], path.join(root, 'ee/packages/den-db'));
} else if (mode === 'api') {
  await run('corepack', ['pnpm', 'exec', 'tsx', 'src/main.ts'], path.join(root, 'ee/apps/den-api'));
} else if (mode === 'web') {
  await run('corepack', ['pnpm', 'exec', 'next', 'dev', '--hostname', '127.0.0.1', '--port', '3005'], path.join(root, 'ee/apps/den-web'), { NODE_OPTIONS: process.env.NODE_OPTIONS || '' });
} else {
  for (const url of ['http://127.0.0.1:8788/health', 'http://127.0.0.1:8788/v1/features', 'http://127.0.0.1:8788/v1/auth/bootstrap/status', 'http://127.0.0.1:3005/api/health']) {
    try { const r = await fetch(url, { signal: AbortSignal.timeout(10000) }); const d = await r.json(); console.log(JSON.stringify({ url, status: r.status, data: url.endsWith('/v1/features') ? { deployment: d.deployment, computerUse: d.features?.computerUse, gitChangesPanel: d.features?.gitChangesPanel, sessionFileBrowser: d.features?.sessionFileBrowser } : d })); }
    catch { console.log(JSON.stringify({ url, status: 'unavailable' })); }
  }
}
