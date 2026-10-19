// Initialize a link: checkout with this DSH installation's host peer packages.
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const args = process.argv.slice(2);
if (args.some(arg => arg !== '--skip-install')) {
  console.error('Usage: npm run setup:local -- [--skip-install]');
  process.exit(1);
}

try {
  let home = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh');
  if (home === '~') home = homedir();
  else if (home.startsWith('~/')) home = join(homedir(), home.slice(2));
  const shared = join(resolve(home), 'profiles', 'node_modules');
  const peers = [];
  for (const name of Object.keys(manifest.peerDependencies)) {
    const source = join(shared, name);
    if (!existsSync(source)) {
      if (manifest.peerDependenciesMeta?.[name]?.optional) continue;
      throw new Error(`Missing host peer ${name}. Initialize a DSH web profile first (${shared}).`);
    }
    peers.push({ name, source, target: join(root, 'node_modules', name) });
  }

  // Check before installation; never overwrite an unrelated peer or broken link.
  const checkTarget = ({ source, target }) => {
    try {
      lstatSync(target);
    } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
    if (!existsSync(target) || realpathSync(target) !== realpathSync(source)) {
      throw new Error(`Inspect the existing peer before retrying: ${target}`);
    }
    return true;
  };
  peers.forEach(checkTarget);
  if (!args.includes('--skip-install')) {
    const npmCli = process.env.npm_execpath;
    const command = npmCli ? process.execPath : process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const installArgs = ['install', '--legacy-peer-deps', '--package-lock=false', '--no-audit', '--no-fund'];
    const result = spawnSync(command, npmCli ? [npmCli, ...installArgs] : installArgs, { cwd: root, stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Dependency installation failed (exit ${result.status}).`);
  }
  for (const peer of peers) {
    if (checkTarget(peer)) continue;
    mkdirSync(dirname(peer.target), { recursive: true });
    symlinkSync(peer.source, peer.target, process.platform === 'win32' ? 'junction' : 'dir');
    console.log(`Linked ${peer.name}`);
  }
  // Verify ESM imports from the checkout's own paths, including native PTY load.
  await import(new URL('../lib/index.js', import.meta.url));
  await import('node-pty');
  await import('ws');
  if (existsSync(join(root, 'src/client.js'))) {
    const build = spawnSync(process.execPath, [join(root, 'scripts/build-client.mjs')], { cwd: root, stdio: 'inherit' });
    if (build.error) throw build.error;
    if (build.status !== 0) throw new Error(`Browser build failed (exit ${build.status}).`);
  }
  console.log('Local dependencies ready. Run npm test, then restart dsh web.');
} catch (error) {
  console.error(`Local setup failed: ${error.message}`);
  process.exitCode = 1;
}
