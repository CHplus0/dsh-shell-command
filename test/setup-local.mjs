import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const fixture = mkdtempSync(join(tmpdir(), 'dsh-local-setup-'));
const put = (path, text) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };
try {
  const root = join(fixture, 'checkout');
  const home = join(fixture, 'home');
  const peer = join(home, 'profiles/node_modules/host-peer');
  mkdirSync(join(root, 'scripts'), { recursive: true });
  copyFileSync(new URL('../scripts/setup-local.mjs', import.meta.url), join(root, 'scripts/setup-local.mjs'));
  put(join(root, 'package.json'), JSON.stringify({
    type: 'module', peerDependencies: { 'host-peer': '*', 'browser-peer': '*' },
    peerDependenciesMeta: { 'browser-peer': { optional: true } },
  }));
  put(join(root, 'lib/index.js'), 'export const name = "fixture";');
  for (const name of ['ws', 'node-pty']) {
    put(join(root, 'node_modules', name, 'package.json'), JSON.stringify({ type: 'module', main: 'index.js' }));
    put(join(root, 'node_modules', name, 'index.js'), 'export default {};');
  }
  const run = (...args) => spawnSync(process.execPath, [join(root, 'scripts/setup-local.mjs'), ...args], {
    cwd: fixture, encoding: 'utf8', env: { ...process.env, DSH_HOME: home },
  });
  const target = join(root, 'node_modules/host-peer');
  const missing = run('--skip-install');
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /Missing host peer/);
  assert.equal(existsSync(target), false);

  put(join(peer, 'package.json'), '{}');
  const first = run('--skip-install');
  assert.equal(first.status, 0, first.stderr);
  assert.equal(realpathSync(target), realpathSync(peer));
  assert.equal(run('--skip-install').status, 0, 'repeated setup is safe');

  rmSync(target);
  put(join(target, 'keep.txt'), 'unrelated peer');
  assert.notEqual(run('--skip-install').status, 0);
  assert.equal(readFileSync(join(target, 'keep.txt'), 'utf8'), 'unrelated peer');
  rmSync(target, { recursive: true });
  symlinkSync(join(fixture, 'missing'), target, process.platform === 'win32' ? 'junction' : 'dir');
  assert.match(run('--skip-install').stderr, /Inspect the existing peer/);
  assert.match(run('--unexpected').stderr, /Usage:/);
  console.log('LOCAL SETUP TESTS PASSED');
} finally {
  rmSync(fixture, { recursive: true, force: true });
}
