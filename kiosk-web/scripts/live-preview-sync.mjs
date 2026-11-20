import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const config = JSON.parse(fs.readFileSync(path.join(root, 'dev/live-preview.json'), 'utf8'));
const stateDirectory = path.join(root, '.live-preview');
fs.mkdirSync(stateDirectory, { recursive: true });
const rootFiles = new Set(['index.html', 'vite.config.ts', 'package.json', 'package-lock.json', 'tsconfig.json']);
const sshOptions = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8'];
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
let timer, running = false, pending = false, dependenciesChanged = false, lastSuccess = null;

async function synchronize() {
  if (running) { pending = true; return; }
  running = true;
  pending = false;
  const installDependencies = dependenciesChanged;
  dependenciesChanged = false;
  try {
    await run('/usr/bin/rsync', [
      '-az', '-e', '/usr/bin/ssh -o BatchMode=yes -o ConnectTimeout=8',
      '--include=/src/***', '--include=/public/***',
      ...[...rootFiles].map(name => `--include=/${name}`), '--exclude=*',
      root, `${config.host}:${config.remoteDirectory}/`,
    ], { timeout: 90000, maxBuffer: 256 * 1024 });
    if (installDependencies) {
      await run('/usr/bin/ssh', [...sshOptions, config.host,
        `cd ${quote(config.remoteDirectory)} && PATH=/home/sdy/.local/share/mise/installs/node/24.22.0/bin:/usr/bin:/bin npm ci && systemctl --user restart ${quote(config.service)}`,
      ], { timeout: 180000, maxBuffer: 512 * 1024 });
    }
    lastSuccess = new Date().toISOString();
    fs.writeFileSync(path.join(stateDirectory, 'status.json'), JSON.stringify({ status: 'ok', lastSuccess, url: config.url }, null, 2));
    console.log(`${lastSuccess} synchronized`);
  } catch (error) {
    dependenciesChanged ||= installDependencies;
    fs.writeFileSync(path.join(stateDirectory, 'status.json'), JSON.stringify({ status: 'retrying', lastSuccess, error: error.message }, null, 2));
    console.error(`${new Date().toISOString()} sync failed; retrying in 15s: ${error.message}`);
    clearTimeout(timer);
    timer = setTimeout(synchronize, 15000);
  } finally {
    running = false;
    if (pending) schedule();
  }
}

function schedule(filename = '') {
  if (filename === 'package-lock.json' || filename === 'package.json') dependenciesChanged = true;
  clearTimeout(timer);
  timer = setTimeout(synchronize, 450);
}

const watchers = [
  ...['src', 'public'].map(directory => fs.watch(path.join(root, directory), { recursive: true }, () => schedule())),
  fs.watch(root, (_event, name) => { if (rootFiles.has(String(name))) schedule(String(name)); }),
];
for (const watcher of watchers) watcher.on('error', error => console.error(error.message));
process.on('SIGTERM', () => { watchers.forEach(w => w.close()); clearTimeout(timer); process.exit(0); });
process.on('SIGINT', () => { watchers.forEach(w => w.close()); clearTimeout(timer); process.exit(0); });
await synchronize();
