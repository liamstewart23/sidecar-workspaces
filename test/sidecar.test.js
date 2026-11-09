'use strict';

const assert = require('assert').strict;
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn, spawnSync } = require('child_process');

const cli = path.resolve(__dirname, '..', 'bin', 'sidecar.js');

function run(cwd, home, ...args) {
  const result = runResult(cwd, home, ...args);
  if (result.status !== 0) throw new Error(`${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

function runResult(cwd, home, ...args) {
  const env = { ...process.env, SIDECAR_HOME: home };
  delete env.SIDECAR_REGISTRY_HOME;
  return runResultWithEnv(cwd, env, ...args);
}

function runResultWithEnv(cwd, env, ...args) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd,
    env,
    encoding: 'utf8'
  });
}

function pause(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (_) {
    return false;
  }
}

function stopProcessGroup(pid) {
  try { process.kill(-pid, 'SIGKILL'); } catch (_) { /* process already stopped */ }
}

function sidecarStatePath(root, stateHome, name) {
  const projectId = require('crypto').createHash('sha256').update(fs.realpathSync(root)).digest('hex').slice(0, 16);
  return path.join(stateHome, 'projects', projectId, 'sessions', name, 'state.json');
}

function storageRootTest() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sidecar-storage-project-'));
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sidecar-storage-root-'));
  const overrideHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sidecar-storage-override-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'sidecar@example.test'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Sidecar Test'], { cwd: root });
    fs.writeFileSync(path.join(root, '.sidecar.json'), JSON.stringify({
      version: 1,
      storage: { root: path.relative(root, storageRoot) }
    }, null, 2));
    fs.writeFileSync(path.join(root, 'message.txt'), 'base\n');
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'base'], { cwd: root });

    const environment = { ...process.env };
    delete environment.SIDECAR_HOME;
    delete environment.SIDECAR_REGISTRY_HOME;
    environment.HOME = overrideHome;
    const configured = runResultWithEnv(root, environment, 'up', 'configured', '--no-watch', '--no-valet');
    assert.equal(configured.status, 0, configured.stderr);
    const configuredState = sidecarStatePath(root, storageRoot, 'configured');
    assert.equal(fs.existsSync(configuredState), true);
    const view = JSON.parse(fs.readFileSync(configuredState, 'utf8')).view;
    assert.match(view, new RegExp(`^${fs.realpathSync(storageRoot).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    const status = runResultWithEnv(view, environment, 'status');
    assert.equal(status.status, 0, status.stderr);
    assert.equal(runResultWithEnv(root, environment, 'up', 'legacy', '--no-watch', '--no-valet').status, 0);
    const legacyState = sidecarStatePath(root, storageRoot, 'legacy');
    const legacyView = JSON.parse(fs.readFileSync(legacyState, 'utf8')).view;
    const projectId = require('crypto').createHash('sha256').update(fs.realpathSync(root)).digest('hex').slice(0, 16);
    fs.unlinkSync(path.join(overrideHome, '.sidecar', 'registry', projectId, 'legacy.json'));

    fs.writeFileSync(path.join(root, '.sidecar.local.json'), JSON.stringify({ storage: { root: path.join(overrideHome, 'new-storage') } }));
    assert.equal(runResultWithEnv(root, environment, 'status', 'configured').status, 0);
    assert.equal(runResultWithEnv(view, environment, 'status').status, 0);
    assert.equal(runResultWithEnv(legacyView, environment, 'status').status, 0);
    assert.equal(runResultWithEnv(legacyView, environment, 'remove', '--force').status, 0);
    assert.notEqual(runResultWithEnv(root, environment, 'up', 'configured').status, 0);
    assert.equal(runResultWithEnv(root, environment, 'down', 'configured').status, 0);
    assert.equal(runResultWithEnv(root, environment, 'remove', 'configured', '--force').status, 0);
    fs.unlinkSync(path.join(root, '.sidecar.local.json'));

    const overridden = runResultWithEnv(root, { ...environment, SIDECAR_HOME: overrideHome }, 'up', 'overridden', '--no-watch', '--no-valet');
    assert.equal(overridden.status, 0, overridden.stderr);
    assert.equal(fs.existsSync(sidecarStatePath(root, overrideHome, 'overridden')), true);
    assert.equal(fs.existsSync(sidecarStatePath(root, storageRoot, 'overridden')), false);

    for (const storage of [null, 'not-an-object', { root: '' }, { root: 42 }]) {
      fs.writeFileSync(path.join(root, '.sidecar.local.json'), JSON.stringify({ storage }));
      const malformed = runResultWithEnv(root, environment, 'up', 'malformed', '--no-watch', '--no-valet');
      assert.notEqual(malformed.status, 0);
      assert.match(malformed.stderr, /storage(?:\.root)? must be/);
    }

    fs.writeFileSync(path.join(root, '.sidecar.local.json'), JSON.stringify({ storage: { root: '.sidecar' } }));
    const invalid = runResultWithEnv(root, environment, 'up', 'invalid', '--no-watch', '--no-valet');
    assert.notEqual(invalid.status, 0);
    assert.match(invalid.stderr, /storage must be outside the project root/);

    const projectLink = path.join(storageRoot, 'project-link');
    fs.symlinkSync(root, projectLink);
    fs.writeFileSync(path.join(root, '.sidecar.local.json'), JSON.stringify({
      storage: { root: path.relative(root, path.join(projectLink, '.sidecar')) }
    }));
    const symlinked = runResultWithEnv(root, environment, 'up', 'symlinked', '--no-watch', '--no-valet');
    assert.notEqual(symlinked.status, 0);
    assert.match(symlinked.stderr, /storage must be outside the project root/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(storageRoot, { recursive: true, force: true });
    fs.rmSync(overrideHome, { recursive: true, force: true });
  }
}

function registryOverrideTest() {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'sidecar-registry-'));
  const root = path.join(parent, 'project');
  const storage = path.join(parent, 'storage');
  const registry = path.join(parent, 'registry-home');
  const badHome = path.join(parent, 'unavailable-home');
  try {
    fs.mkdirSync(root);
    fs.writeFileSync(badHome, 'not a directory');
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'sidecar@example.test'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Sidecar Test'], { cwd: root });
    fs.writeFileSync(path.join(root, '.sidecar.json'), JSON.stringify({ version: 1, storage: { root: storage } }));
    fs.writeFileSync(path.join(root, 'file.txt'), 'base\n');
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'base'], { cwd: root });
    const environment = { ...process.env, HOME: badHome, SIDECAR_REGISTRY_HOME: registry };
    delete environment.SIDECAR_HOME;
    const stateCrash = path.join(parent, 'state-crash.js');
    fs.writeFileSync(stateCrash, `const fs = require('fs'); const write = fs.writeFileSync; fs.writeFileSync = function(file, ...args) { if (typeof file === 'string' && file.includes('/.state-') && file.endsWith('/state.json')) { write.call(this, file, '{'); process.kill(process.pid, 'SIGKILL'); } return write.call(this, file, ...args); };\n`);
    const interruptedState = runResultWithEnv(root, { ...environment, NODE_OPTIONS: `--require=${JSON.stringify(stateCrash)}` }, 'up', 'state-crash');
    assert.equal(interruptedState.signal, 'SIGKILL');
    const stateRecovery = runResultWithEnv(root, environment, 'recover', 'state-crash', '--force');
    assert.equal(stateRecovery.status, 0, stateRecovery.stderr);
    assert.match(stateRecovery.stdout, /Preserved interrupted Sidecar files/);
    assert.equal(runResultWithEnv(root, environment, 'up', 'state-crash').status, 0);
    assert.equal(runResultWithEnv(root, environment, 'remove', 'state-crash', '--force').status, 0);
    assert.equal(runResultWithEnv(root, environment, 'up', 'corrupt-state').status, 0);
    const corruptState = sidecarStatePath(root, storage, 'corrupt-state');
    const corruptView = JSON.parse(fs.readFileSync(corruptState, 'utf8')).view;
    fs.writeFileSync(path.join(corruptView, 'preserve.txt'), 'keep this');
    fs.writeFileSync(corruptState, '{');
    assert.match(runResultWithEnv(root, environment, 'recover', 'corrupt-state', '--force').stderr, /--unverified/);
    const corruptRecovery = runResultWithEnv(root, environment, 'recover', 'corrupt-state', '--force', '--unverified');
    assert.equal(corruptRecovery.status, 0, corruptRecovery.stderr);
    const archived = corruptRecovery.stdout.match(/Preserved interrupted Sidecar files at (.+)\./)[1];
    assert.equal(fs.readFileSync(path.join(archived, path.basename(corruptView), 'preserve.txt'), 'utf8'), 'keep this');
    assert.equal(runResultWithEnv(root, environment, 'recover', 'corrupt-state', '--force', '--clear-registry', '--unverified').status, 0);
    assert.equal(runResultWithEnv(root, environment, 'up', 'corrupt-state').status, 0);
    assert.equal(runResultWithEnv(root, environment, 'remove', 'corrupt-state', '--force').status, 0);
    const brokenRegistry = path.join(parent, 'broken-registry.js');
    fs.writeFileSync(brokenRegistry, `const fs = require('fs'); const write = fs.writeFileSync; fs.writeFileSync = function(file, ...args) { if (typeof file === 'string' && file.includes('/registry/') && file.endsWith('/entry.json')) { write.call(this, file, '{'); const error = new Error('simulated full disk'); error.code = 'ENOSPC'; throw error; } return write.call(this, file, ...args); };\n`);
    const failedRegistry = runResultWithEnv(root, { ...environment, NODE_OPTIONS: `--require=${JSON.stringify(brokenRegistry)}` }, 'up', 'registry-failure');
    assert.notEqual(failedRegistry.status, 0);
    assert.match(failedRegistry.stderr, /simulated full disk/);
    const id = require('crypto').createHash('sha256').update(fs.realpathSync(root)).digest('hex').slice(0, 16);
    assert.equal(fs.existsSync(path.join(registry, 'registry', id, 'registry-failure.json')), false);
    assert.equal(runResultWithEnv(root, environment, 'up', 'registry-failure').status, 0);
    assert.equal(runResultWithEnv(root, environment, 'remove', 'registry-failure', '--force').status, 0);
    const registryCrash = path.join(parent, 'registry-crash.js');
    fs.writeFileSync(registryCrash, `const fs = require('fs'); const open = fs.openSync; fs.linkSync = () => { const error = new Error('unsupported'); error.code = 'ENOTSUP'; throw error; }; fs.openSync = function(file, ...args) { const fd = open.call(this, file, ...args); if (typeof file === 'string' && file.endsWith('/fallback-crash.json') && args[0] === 'wx') process.kill(process.pid, 'SIGKILL'); return fd; };\n`);
    const crashed = runResultWithEnv(root, { ...environment, NODE_OPTIONS: `--require=${JSON.stringify(registryCrash)}` }, 'up', 'fallback-crash');
    assert.equal(crashed.signal, 'SIGKILL');
    assert.match(runResultWithEnv(root, environment, 'status', 'fallback-crash').stderr, /Could not read Sidecar registry/);
    assert.notEqual(runResultWithEnv(root, environment, 'recover', 'fallback-crash', '--force', '--clear-registry').status, 0);
    const repaired = runResultWithEnv(root, environment, 'recover', 'fallback-crash', '--force', '--clear-registry', '--unverified');
    assert.equal(repaired.status, 0, repaired.stderr);
    assert.match(repaired.stdout, /Preserved the registry entry/);
    assert.equal(runResultWithEnv(root, environment, 'status', 'fallback-crash').status, 0);
    assert.equal(runResultWithEnv(root, environment, 'remove', 'fallback-crash', '--force').status, 0);
    assert.equal(runResultWithEnv(root, environment, 'recover', 'fallback-crash', '--force').status, 0);
    assert.equal(runResultWithEnv(root, environment, 'up', 'old-removal').status, 0);
    const oldRemovalState = sidecarStatePath(root, storage, 'old-removal');
    fs.renameSync(oldRemovalState, `${oldRemovalState}.saved`);
    const presentSession = runResultWithEnv(root, environment, 'recover', 'old-removal', '--force', '--clear-registry', '--unverified');
    assert.notEqual(presentSession.status, 0);
    assert.match(presentSession.stderr, /existing session directory/);
    fs.renameSync(`${oldRemovalState}.saved`, oldRemovalState);
    // Simulate a previous version removing the session without removing the newer registry entry.
    fs.rmSync(path.dirname(oldRemovalState), { recursive: true, force: true });
    assert.match(runResultWithEnv(root, environment, 'up', 'old-removal').stderr, /state is missing/);
    assert.notEqual(runResultWithEnv(root, environment, 'recover', 'old-removal', '--force', '--clear-registry').status, 0);
    assert.equal(runResultWithEnv(root, environment, 'recover', 'old-removal', '--force', '--clear-registry', '--unverified').status, 0);
    assert.equal(runResultWithEnv(root, environment, 'up', 'old-removal').status, 0);
    assert.equal(runResultWithEnv(root, environment, 'remove', 'old-removal', '--force').status, 0);
    const noLinks = path.join(parent, 'no-hardlinks.js');
    fs.writeFileSync(noLinks, 'require("fs").linkSync = () => { const error = new Error("unsupported"); error.code = "ENOTSUP"; throw error; };\n');
    const noLinkEnvironment = { ...environment, NODE_OPTIONS: `--require=${JSON.stringify(noLinks)}` };
    const noLinkUp = runResultWithEnv(root, noLinkEnvironment, 'up', 'no-links');
    assert.equal(noLinkUp.status, 0, noLinkUp.stderr);
    assert.equal(runResultWithEnv(root, noLinkEnvironment, 'remove', 'no-links', '--force').status, 0);
    const up = runResultWithEnv(root, environment, 'up', 'external');
    assert.equal(up.status, 0, up.stderr);
    const state = sidecarStatePath(root, storage, 'external');
    const view = JSON.parse(fs.readFileSync(state, 'utf8')).view;
    const projectId = require('crypto').createHash('sha256').update(fs.realpathSync(root)).digest('hex').slice(0, 16);
    assert.equal(fs.existsSync(path.join(registry, 'registry', projectId, 'external.json')), true);
    fs.writeFileSync(path.join(view, 'file.txt'), 'changed\n');
    const applied = runResultWithEnv(view, environment, 'apply');
    assert.equal(applied.status, 0, applied.stderr);
    assert.equal(fs.readFileSync(path.join(root, 'file.txt'), 'utf8'), 'changed\n');
    assert.equal(runResultWithEnv(view, environment, 'remove', '--force').status, 0);
    assert.equal(fs.existsSync(state), false);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
}

function lifecycleTest() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sidecar-project-'));
  const stateHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sidecar-state-'));
  const shutdownMarker = path.join(os.tmpdir(), `sidecar-shutdown-${Date.now()}.txt`);
  try {
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'sidecar@example.test'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Sidecar Test'], { cwd: root });
    fs.writeFileSync(path.join(root, '.sidecar.json'), JSON.stringify({
      version: 1,
      runtime: { shell: '/bin/sh', bootstrap: ['export SIDECAR_TEST_RUNTIME=ready'] },
      processes: {
        watch: { command: 'sleep 30' },
        custom: { command: 'sleep 30' }
      },
      tasks: {
        marker: { command: 'printf "%s:%s" "$SIDECAR_NAME" "$SIDECAR_TEST_RUNTIME" > task.txt' },
        before: { command: 'printf before > before-up.txt' },
        argument: { command: 'printf "%s" > task-argument.txt' },
        beforeDown: { command: `printf before >> "${shutdownMarker}"` },
        afterDown: { command: `printf after >> "${shutdownMarker}"` }
      },
      hooks: { beforeUp: ['before'], afterUp: ['marker'], beforeDown: ['beforeDown'], afterDown: ['afterDown'] },
      valet: { domain: '{branch}-{name}.test', enabled: false }
    }, null, 2));
    fs.writeFileSync(path.join(root, 'SIDECAR.md'), 'Name: {name}\nBranch: {branch}\nView: {view}\n');
    fs.writeFileSync(path.join(root, 'message.txt'), 'base\n');
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'base'], { cwd: root });

    const up = run(root, stateHome, 'up', 'dev-42', '--no-valet', '--no-watch');
    assert.match(up, /Sidecar dev-42 is ready/);
    const statePath = sidecarStatePath(root, stateHome, 'dev-42');
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    const view = state.view;
    assert.equal(state.domain, '');
    assert.equal(state.url, '');
    assert.equal(fs.readFileSync(path.join(view, 'before-up.txt'), 'utf8'), 'before');
    assert.equal(fs.readFileSync(path.join(view, 'task.txt'), 'utf8'), 'dev-42:ready');
    assert.match(run(view, stateHome, 'status'), /Sidecar: dev-42/);
    run(view, stateHome, 'task', 'argument', '--', 'inside the view');
    assert.equal(fs.readFileSync(path.join(view, 'task-argument.txt'), 'utf8'), 'inside the view');
    run(view, stateHome, 'task', 'dev-42', 'argument', '--', 'explicit inside the view');
    assert.equal(fs.readFileSync(path.join(view, 'task-argument.txt'), 'utf8'), 'explicit inside the view');
    run(view, stateHome, 'watch', 'dev-42');
    run(view, stateHome, 'watch', 'custom');
    assert.match(run(view, stateHome, 'watch', 'dev-42', 'custom'), /custom is already running/);
    run(view, stateHome, 'exec', '--', 'sh', '-c', 'printf inside > inside-exec.txt');
    assert.equal(fs.readFileSync(path.join(view, 'inside-exec.txt'), 'utf8'), 'inside');
    run(root, stateHome, 'task', 'dev-42', 'argument', '--', 'hello world');
    assert.equal(fs.readFileSync(path.join(view, 'task-argument.txt'), 'utf8'), 'hello world');
    const guide = run(root, stateHome, 'guide', 'dev-42');
    assert.match(guide, /Name: dev-42/);
    assert.match(guide, new RegExp(`View: ${view.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    run(root, stateHome, 'exec', 'dev-42', '--', 'sh', '-c', 'printf "%s" "$SIDECAR_TEST_RUNTIME" > exec.txt');
    assert.equal(fs.readFileSync(path.join(view, 'exec.txt'), 'utf8'), 'ready');
    const signalled = runResult(root, stateHome, 'exec', 'dev-42', '--', 'sh', '-c', 'kill -TERM $$');
    assert.equal(signalled.status, 143);
    fs.writeFileSync(path.join(view, 'message.txt'), 'sidecar\n');
    fs.writeFileSync(path.join(view, 'new.txt'), 'new file\n');
    fs.symlinkSync('message.txt', path.join(view, 'message-link.txt'));

    const diff = run(root, stateHome, 'diff', 'dev-42');
    assert.match(diff, /message.txt/);
    assert.match(diff, /new.txt/);

    run(root, stateHome, 'apply', 'dev-42');
    assert.equal(fs.readFileSync(path.join(root, 'message.txt'), 'utf8'), 'sidecar\n');
    assert.equal(fs.readFileSync(path.join(root, 'new.txt'), 'utf8'), 'new file\n');
    assert.equal(fs.lstatSync(path.join(root, 'message-link.txt')).isSymbolicLink(), true);
    assert.equal(fs.readlinkSync(path.join(root, 'message-link.txt')), 'message.txt');

    run(root, stateHome, 'down', 'dev-42');
    assert.equal(fs.readFileSync(shutdownMarker, 'utf8'), 'beforeafter');
    run(root, stateHome, 'remove', 'dev-42', '--force');
    assert.equal(fs.readFileSync(shutdownMarker, 'utf8'), 'beforeafterbeforeafter');
    assert.equal(fs.existsSync(path.dirname(view)), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(stateHome, { recursive: true, force: true });
    fs.rmSync(shutdownMarker, { force: true });
  }
}

function failedStartupTest() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sidecar-failed-up-'));
  const stateHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sidecar-failed-up-state-'));
  const pidFile = path.join(os.tmpdir(), `sidecar-failed-up-${Date.now()}.pid`);
  try {
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'sidecar@example.test'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Sidecar Test'], { cwd: root });
    fs.writeFileSync(path.join(root, '.sidecar.json'), JSON.stringify({
      version: 1,
      processes: { watch: { command: `echo $$ > "${pidFile}"; exec sleep 30`, autostart: true } },
      tasks: { fail: { command: 'false' } },
      hooks: { afterUp: ['fail'] }
    }, null, 2));
    fs.writeFileSync(path.join(root, 'message.txt'), 'base\n');
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'base'], { cwd: root });

    const failed = runResult(root, stateHome, 'up', 'broken', '--no-valet');
    assert.notEqual(failed.status, 0);
    const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
    assert.throws(() => process.kill(pid, 0));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(stateHome, { recursive: true, force: true });
    fs.rmSync(pidFile, { force: true });
  }
}

function processSafetyTest() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sidecar-process-safety-'));
  const stateHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sidecar-process-safety-state-'));
  let foreignPid;
  try {
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'sidecar@example.test'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Sidecar Test'], { cwd: root });
    fs.writeFileSync(path.join(root, '.sidecar.json'), JSON.stringify({
      version: 1,
      processes: {
        watch: {
          command: "trap '' TERM; while :; do sleep 1; done",
          autostart: true,
          shutdownTimeoutMs: 100
        }
      }
    }, null, 2));
    fs.writeFileSync(path.join(root, 'message.txt'), 'base\n');
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'base'], { cwd: root });

    const torontoEnv = { ...process.env, SIDECAR_HOME: stateHome, TZ: 'America/Toronto', LC_ALL: 'C' };
    delete torontoEnv.SIDECAR_REGISTRY_HOME;
    const managedUp = runResultWithEnv(root, torontoEnv, 'up', 'managed', '--no-valet');
    assert.equal(managedUp.status, 0, managedUp.stderr);
    const managedState = JSON.parse(fs.readFileSync(sidecarStatePath(root, stateHome, 'managed'), 'utf8'));
    const managedPid = managedState.processes.watch.pid;
    assert.equal(managedState.processes.watch.identity.pid, managedPid);
    const torontoPs = spawnSync('ps', ['-o', 'pid=', '-o', 'pgid=', '-o', 'lstart=', '-p', String(managedPid)], { env: torontoEnv, encoding: 'utf8' });
    assert.equal(torontoPs.status, 0, torontoPs.stderr);
    const torontoStart = torontoPs.stdout.trim().match(/^\d+\s+\d+\s+(.+)$/);
    assert.ok(torontoStart);
    assert.equal(managedState.processes.watch.identity.startedAt, torontoStart[1]);
    const tokyoEnv = { ...process.env, SIDECAR_HOME: stateHome, TZ: 'Asia/Tokyo', LC_ALL: 'C' };
    delete tokyoEnv.SIDECAR_REGISTRY_HOME;
    const managedDown = runResultWithEnv(root, tokyoEnv, 'down', 'managed');
    assert.equal(managedDown.status, 0, managedDown.stderr);
    for (let attempt = 0; attempt < 20 && processIsAlive(managedPid); attempt += 1) pause(50);
    assert.equal(processIsAlive(managedPid), false);

    run(root, stateHome, 'up', 'legacy-managed', '--no-valet');
    const legacyPath = sidecarStatePath(root, stateHome, 'legacy-managed');
    const legacyState = JSON.parse(fs.readFileSync(legacyPath, 'utf8'));
    const legacyPid = legacyState.processes.watch.pid;
    const oldPs = spawnSync('ps', ['-o', 'pid=', '-o', 'pgid=', '-o', 'lstart=', '-p', String(legacyPid)], { env: tokyoEnv, encoding: 'utf8' });
    assert.equal(oldPs.status, 0, oldPs.stderr);
    const oldStart = oldPs.stdout.trim().match(/^\d+\s+\d+\s+(.+)$/);
    assert.ok(oldStart);
    legacyState.processes.watch.identity.startedAt = oldStart[1];
    delete legacyState.processes.watch.identity.timeBasis;
    delete legacyState.processes.watch.identity.utcStartedAt;
    fs.writeFileSync(legacyPath, JSON.stringify(legacyState));
    const legacyDown = runResultWithEnv(root, tokyoEnv, 'down', 'legacy-managed');
    assert.equal(legacyDown.status, 0, legacyDown.stderr);
    for (let attempt = 0; attempt < 20 && processIsAlive(legacyPid); attempt += 1) pause(50);
    assert.equal(processIsAlive(legacyPid), false);

    run(root, stateHome, 'up', 'stale', '--no-valet', '--no-watch');
    const foreign = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
    foreign.unref();
    foreignPid = foreign.pid;
    const stalePath = sidecarStatePath(root, stateHome, 'stale');
    const staleState = JSON.parse(fs.readFileSync(stalePath, 'utf8'));
    staleState.processes = {
      watch: {
        pid: foreignPid,
        identity: { pid: foreignPid, pgid: foreignPid, startedAt: 'an intentionally mismatched start time' }
      }
    };
    fs.writeFileSync(stalePath, `${JSON.stringify(staleState, null, 2)}\n`);
    run(root, stateHome, 'down', 'stale');
    assert.equal(processIsAlive(foreignPid), true);
  } finally {
    if (foreignPid) stopProcessGroup(foreignPid);
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(stateHome, { recursive: true, force: true });
  }
}

function invalidShellAndApplySafetyTest() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sidecar-safety-'));
  const stateHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sidecar-safety-state-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'sidecar@example.test'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Sidecar Test'], { cwd: root });
    fs.writeFileSync(path.join(root, '.sidecar.json'), JSON.stringify({
      version: 1,
      processes: { watch: { command: 'sleep 30', autostart: true } }
    }, null, 2));
    fs.writeFileSync(path.join(root, '.gitignore'), '.sidecar.local.json\n');
    fs.writeFileSync(path.join(root, 'message.txt'), 'base\n');
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'base'], { cwd: root });

    fs.writeFileSync(path.join(root, '.sidecar.local.json'), JSON.stringify({ runtime: { shell: '/definitely/not/a/shell' } }));
    const failed = runResult(root, stateHome, 'up', 'bad-shell', '--no-valet');
    assert.notEqual(failed.status, 0);
    assert.equal(fs.existsSync(sidecarStatePath(root, stateHome, 'bad-shell')), false);
    fs.unlinkSync(path.join(root, '.sidecar.local.json'));

    fs.writeFileSync(path.join(root, '.git', 'info', 'exclude'), 'collision.txt\n');
    fs.symlinkSync('missing-target', path.join(root, 'collision.txt'));
    run(root, stateHome, 'up', 'apply-safety', '--no-valet', '--no-watch');
    const view = JSON.parse(fs.readFileSync(sidecarStatePath(root, stateHome, 'apply-safety'), 'utf8')).view;
    fs.writeFileSync(path.join(view, 'message.txt'), 'sidecar\n');
    fs.unlinkSync(path.join(view, 'collision.txt'));
    fs.writeFileSync(path.join(view, '.git', 'info', 'exclude'), '');
    fs.writeFileSync(path.join(view, 'collision.txt'), 'untracked\n');
    const rejected = runResult(root, stateHome, 'apply', 'apply-safety');
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /Cannot apply untracked file safely: collision.txt/);
    assert.equal(fs.readFileSync(path.join(root, 'message.txt'), 'utf8'), 'base\n');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(stateHome, { recursive: true, force: true });
  }
}

function initTest() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sidecar-init-'));
  const stateHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sidecar-init-state-'));
  try {
    run(root, stateHome, 'init');
    assert.equal(fs.existsSync(path.join(root, '.sidecar.json')), true);
    assert.equal(fs.existsSync(path.join(root, 'SIDECAR.md')), false);
    assert.equal(fs.existsSync(path.join(root, '.gitignore')), false);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, '.sidecar.json'), 'utf8')), { version: 1 });
    run(root, stateHome, 'up', 'non-git');
    assert.match(run(root, stateHome, 'status', 'non-git'), /not a Git repository/);
    run(root, stateHome, 'remove', 'non-git', '--force');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(stateHome, { recursive: true, force: true });
  }
}

function noConfigTest() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sidecar-default-project-'));
  const stateHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sidecar-default-state-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'sidecar@example.test'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Sidecar Test'], { cwd: root });
    fs.mkdirSync(path.join(root, 'nested'));
    fs.writeFileSync(path.join(root, 'nested', 'message.txt'), 'base\n');
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'base'], { cwd: root });

    run(path.join(root, 'nested'), stateHome, 'up', 'simple');
    const statePath = sidecarStatePath(root, stateHome, 'simple');
    const view = JSON.parse(fs.readFileSync(statePath, 'utf8')).view;
    assert.equal(fs.existsSync(path.join(root, '.sidecar.json')), false);
    assert.match(run(view, stateHome, 'status'), /Sidecar: simple/);
    run(view, stateHome, 'exec', '--', process.execPath, '-e', 'require("fs").writeFileSync("new.txt", "new")');
    fs.writeFileSync(path.join(view, 'nested', 'message.txt'), 'changed\n');
    assert.match(run(view, stateHome, 'diff'), /nested\/message.txt/);
    run(view, stateHome, 'apply');
    assert.equal(fs.readFileSync(path.join(root, 'nested', 'message.txt'), 'utf8'), 'changed\n');
    assert.equal(fs.readFileSync(path.join(root, 'new.txt'), 'utf8'), 'new');
    run(view, stateHome, 'down');
    run(view, stateHome, 'remove', '--force');
    assert.equal(fs.existsSync(statePath), false);

    const dirty = runResult(root, stateHome, 'up', 'dirty');
    assert.notEqual(dirty.status, 0);
    assert.match(dirty.stderr, /uncommitted changes/);

    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'changes'], { cwd: root });
    const nested = path.join(root, 'nested');
    fs.writeFileSync(path.join(nested, '.sidecar.json'), '{"version":1}\n');
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'nested config'], { cwd: root });
    const rejected = runResult(nested, stateHome, 'up', 'configured');
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /subdirectory of a Git checkout/);
    assert.equal(fs.existsSync(sidecarStatePath(nested, stateHome, 'configured')), false);

    // An existing workspace from before this check must remain manageable.
    const oldStatePath = sidecarStatePath(nested, stateHome, 'configured');
    const oldView = path.join(path.dirname(oldStatePath), 'view');
    fs.mkdirSync(oldView, { recursive: true });
    fs.writeFileSync(oldStatePath, JSON.stringify({ name: 'configured', projectRoot: fs.realpathSync(nested), view: oldView, backend: 'copy', processes: {} }));
    assert.match(run(nested, stateHome, 'status', 'configured'), /Sidecar: configured/);
    run(nested, stateHome, 'remove', 'configured', '--force');
    assert.equal(fs.existsSync(oldStatePath), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(stateHome, { recursive: true, force: true });
  }
}

function discoveryBoundaryTest() {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'sidecar-parent-'));
  const stateHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sidecar-discovery-state-'));
  const root = path.join(parent, 'project');
  try {
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(parent, '.sidecar.json'), JSON.stringify({ version: 1, hooks: { beforeUp: ['unexpected'] } }));
    execFileSync('git', ['init', '-q'], { cwd: root });
    fs.writeFileSync(path.join(root, 'file.txt'), 'new');
    const noCommit = runResult(root, stateHome, 'up', 'unborn');
    assert.notEqual(noCommit.status, 0);
    assert.match(noCommit.stderr, /initial commit/);
    execFileSync('git', ['config', 'user.email', 'sidecar@example.test'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Sidecar Test'], { cwd: root });
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'base'], { cwd: root });
    run(root, stateHome, 'up', 'boundary');
    const state = JSON.parse(fs.readFileSync(sidecarStatePath(root, stateHome, 'boundary'), 'utf8'));
    assert.equal(state.projectRoot, fs.realpathSync(root));
    run(root, stateHome, 'remove', 'boundary', '--force');

    const spacedRoot = path.join(parent, 'project ');
    fs.mkdirSync(spacedRoot);
    execFileSync('git', ['init', '-q'], { cwd: spacedRoot });
    execFileSync('git', ['config', 'user.email', 'sidecar@example.test'], { cwd: spacedRoot });
    execFileSync('git', ['config', 'user.name', 'Sidecar Test'], { cwd: spacedRoot });
    fs.writeFileSync(path.join(spacedRoot, '.sidecar.json'), '{"version":1}\n');
    fs.writeFileSync(path.join(spacedRoot, 'file.txt'), 'base\n');
    execFileSync('git', ['add', '.'], { cwd: spacedRoot });
    execFileSync('git', ['commit', '-qm', 'base'], { cwd: spacedRoot });
    run(spacedRoot, stateHome, 'up', 'spaced');
    run(spacedRoot, stateHome, 'diff', 'spaced');
    run(spacedRoot, stateHome, 'remove', 'spaced', '--force');
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
    fs.rmSync(stateHome, { recursive: true, force: true });
  }
}

function legacyParentSessionTest() {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'sidecar-legacy-parent-'));
  const stateHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sidecar-legacy-parent-state-'));
  const root = path.join(parent, 'project');
  try {
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(parent, '.sidecar.json'), '{"version":1}\n');
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'sidecar@example.test'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Sidecar Test'], { cwd: root });
    fs.writeFileSync(path.join(root, 'file.txt'), 'base\n');
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'base'], { cwd: root });

    run(parent, stateHome, 'up', 'existing');
    const parentState = sidecarStatePath(parent, stateHome, 'existing');
    const parentView = JSON.parse(fs.readFileSync(parentState, 'utf8')).view;
    const id = require('crypto').createHash('sha256').update(fs.realpathSync(parent)).digest('hex').slice(0, 16);
    fs.unlinkSync(path.join(stateHome, 'registry', id, 'existing.json'));
    assert.ok(run(root, stateHome, 'status', 'existing').includes(parentView));

    run(root, stateHome, 'up', 'existing');
    const localState = sidecarStatePath(root, stateHome, 'existing');
    const localView = JSON.parse(fs.readFileSync(localState, 'utf8')).view;
    assert.ok(run(root, stateHome, 'status', 'existing').includes(localView));
    run(root, stateHome, 'remove', 'existing', '--force');
    assert.equal(fs.existsSync(parentState), true);
    assert.ok(run(root, stateHome, 'status', 'existing').includes(parentView));
    run(root, stateHome, 'remove', 'existing', '--force');
    assert.equal(fs.existsSync(parentState), false);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
    fs.rmSync(stateHome, { recursive: true, force: true });
  }
}

function isolationBoundaryTest() {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'sidecar-isolation-'));
  const root = path.join(parent, 'project');
  const worktree = path.join(parent, 'worktree');
  const stateHome = path.join(parent, 'state');
  try {
    fs.mkdirSync(root);
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'sidecar@example.test'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Sidecar Test'], { cwd: root });
    fs.writeFileSync(path.join(root, '.sidecar.json'), JSON.stringify({ version: 1, storage: { root: path.join(parent, 'storage') } }));
    fs.writeFileSync(path.join(root, 'file.txt'), 'base\n');
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'base'], { cwd: root });
    execFileSync('git', ['worktree', 'add', '-qb', 'sidecar-test', worktree], { cwd: root });

    const linked = runResult(worktree, stateHome, 'up', 'linked');
    assert.notEqual(linked.status, 0);
    assert.match(linked.stderr, /linked worktrees/);
    assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: worktree, encoding: 'utf8' }), '');
    assert.equal(fs.existsSync(sidecarStatePath(worktree, stateHome, 'linked')), false);

    const environment = { ...process.env, HOME: root };
    delete environment.SIDECAR_HOME;
    const inside = runResultWithEnv(root, environment, 'up', 'home-project');
    assert.notEqual(inside.status, 0);
    assert.match(inside.stderr, /registry must be outside/);
    assert.equal(fs.existsSync(path.join(root, '.sidecar')), false);
    assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }), '');
    const external = { ...environment, SIDECAR_HOME: stateHome };
    assert.equal(runResultWithEnv(root, external, 'up', 'home-project').status, 0);
    assert.equal(runResultWithEnv(root, external, 'apply', 'home-project').status, 0);
    assert.equal(runResultWithEnv(root, external, 'remove', 'home-project', '--force').status, 0);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
}

function concurrentStartupTest() {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'sidecar-concurrent-'));
  const root = path.join(parent, 'project');
  const stateHome = path.join(parent, 'state');
  const shimDir = path.join(parent, 'bin');
  try {
    fs.mkdirSync(root);
    fs.mkdirSync(shimDir);
    const shim = path.join(shimDir, 'cp');
    fs.writeFileSync(shim, '#!/bin/sh\ntouch "$SIDECAR_TEST_READY"\nwhile [ ! -f "$SIDECAR_TEST_RELEASE" ]; do sleep 0.05; done\n/bin/cp "$@"\nresult=$?\ntouch "$SIDECAR_TEST_COPY_DONE"\nexit "$result"\n');
    fs.chmodSync(shim, 0o755);
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'sidecar@example.test'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Sidecar Test'], { cwd: root });
    fs.writeFileSync(path.join(root, 'file.txt'), 'base\n');
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'base'], { cwd: root });
    const env = { ...process.env, SIDECAR_HOME: stateHome, PATH: `${shimDir}${path.delimiter}${process.env.PATH}`, SIDECAR_TEST_READY: path.join(parent, 'ready'), SIDECAR_TEST_RELEASE: path.join(parent, 'release'), SIDECAR_TEST_COPY_DONE: path.join(parent, 'copy-done') };
    delete env.SIDECAR_REGISTRY_HOME;
    const script = `
      "$1" "$2" up same > "$3/first.out" 2> "$3/first.err" &
      first=$!
      trap 'touch "$SIDECAR_TEST_RELEASE"; kill "$first" 2>/dev/null || true' EXIT
      attempts=0
      while [ ! -f "$SIDECAR_TEST_READY" ]; do
        attempts=$((attempts + 1))
        [ "$attempts" -lt 200 ] || exit 1
        sleep 0.05
      done
      "$1" "$2" up same > "$3/second.out" 2> "$3/second.err"
      second=$?
      "$1" "$2" recover same --force > "$3/recover.out" 2> "$3/recover.err"
      recover=$?
      touch "$SIDECAR_TEST_RELEASE"
      wait "$first" || exit 1
      [ "$second" -ne 0 ] || exit 1
      [ "$recover" -ne 0 ] || exit 1
      trap - EXIT
    `;
    const result = spawnSync('sh', ['-c', script, 'sidecar-test', process.execPath, cli, parent], { cwd: root, env, encoding: 'utf8', timeout: 20000 });
    assert.equal(result.status, 0, `${result.stderr}\n${fs.readFileSync(path.join(parent, 'first.err'), 'utf8')}`);
    assert.match(fs.readFileSync(path.join(parent, 'second.err'), 'utf8'), /already being created/);
    assert.match(fs.readFileSync(path.join(parent, 'recover.err'), 'utf8'), /may still be starting/);
    const state = sidecarStatePath(root, stateHome, 'same');
    const view = JSON.parse(fs.readFileSync(state, 'utf8')).view;
    fs.writeFileSync(path.join(view, 'work.txt'), 'preserved');
    assert.match(run(root, stateHome, 'status', 'same'), /Sidecar: same/);
    assert.equal(fs.readFileSync(path.join(view, 'work.txt'), 'utf8'), 'preserved');
    run(root, stateHome, 'remove', 'same', '--force');

    const staleState = sidecarStatePath(root, stateHome, 'stale');
    fs.mkdirSync(path.dirname(staleState), { recursive: true });
    fs.writeFileSync(path.join(path.dirname(staleState), 'work.txt'), 'preserved');
    const stale = runResult(root, stateHome, 'up', 'stale');
    assert.notEqual(stale.status, 0);
    assert.equal(fs.readFileSync(path.join(path.dirname(staleState), 'work.txt'), 'utf8'), 'preserved');
    const staleClaim = `${path.dirname(staleState)}.creating`;
    const recoveryLock = `${staleClaim}.recovering`;
    fs.mkdirSync(recoveryLock);
    fs.writeFileSync(path.join(recoveryLock, 'owner.json'), JSON.stringify({ pid: process.pid }));
    assert.notEqual(runResult(root, stateHome, 'recover', 'stale', '--force').status, 0);
    assert.notEqual(runResult(root, stateHome, 'recover', 'stale', '--force', '--clear-recovery-lock').status, 0);
    fs.writeFileSync(path.join(recoveryLock, 'owner.json'), JSON.stringify({ pid: 2147483647 }));
    const slowClear = path.join(parent, 'slow-clear.js');
    fs.writeFileSync(slowClear, `const fs = require('fs'); const original = fs.rmSync; fs.rmSync = function(target, ...args) { if (String(target).endsWith('.creating.recovering')) { fs.writeFileSync(process.env.CLEAR_READY, ''); while (!fs.existsSync(process.env.CLEAR_RELEASE)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25); } return original.call(this, target, ...args); };\n`);
    const clearEnv = { ...env, CLEAR_READY: path.join(parent, 'clear-ready'), CLEAR_RELEASE: path.join(parent, 'clear-release') };
    const clearScript = `
      NODE_OPTIONS="$4" "$1" "$2" recover stale --force --clear-recovery-lock > "$3/clear-first.out" 2> "$3/clear-first.err" &
      first=$!
      trap 'touch "$CLEAR_RELEASE"; kill "$first" 2>/dev/null || true' EXIT
      attempts=0
      while [ ! -f "$CLEAR_READY" ]; do
        attempts=$((attempts + 1)); [ "$attempts" -lt 200 ] || exit 1; sleep 0.05
      done
      "$1" "$2" recover stale --force --clear-recovery-lock > "$3/clear-second.out" 2> "$3/clear-second.err"
      second=$?
      touch "$CLEAR_RELEASE"
      wait "$first" || exit 1
      [ "$second" -ne 0 ] || exit 1
      trap - EXIT
    `;
    const clears = spawnSync('sh', ['-c', clearScript, 'sidecar-test', process.execPath, cli, parent, `--require=${JSON.stringify(slowClear)}`], { cwd: root, env: clearEnv, encoding: 'utf8', timeout: 20000 });
    assert.equal(clears.status, 0, clears.stderr);
    assert.match(fs.readFileSync(path.join(parent, 'clear-second.err'), 'utf8'), /already in progress/);
    fs.writeFileSync(staleClaim, '');
    assert.notEqual(runResult(root, stateHome, 'recover', 'stale', '--force').status, 0);
    const recovered = run(root, stateHome, 'recover', 'stale', '--force', '--unverified');
    const preserved = recovered.match(/Preserved interrupted Sidecar files at (.+)\./)[1];
    assert.equal(fs.readFileSync(path.join(preserved, 'work.txt'), 'utf8'), 'preserved');
    run(root, stateHome, 'up', 'stale');
    run(root, stateHome, 'remove', 'stale', '--force');

    fs.mkdirSync(recoveryLock);
    assert.notEqual(runResult(root, stateHome, 'recover', 'stale', '--force', '--clear-recovery-lock').status, 0);
    run(root, stateHome, 'recover', 'stale', '--force', '--clear-recovery-lock', '--unverified');

    const crashedRoot = path.dirname(sidecarStatePath(root, stateHome, 'crashed-recovery'));
    fs.mkdirSync(crashedRoot, { recursive: true });
    fs.writeFileSync(path.join(crashedRoot, 'work.txt'), 'preserved after recovery crash');
    fs.writeFileSync(`${crashedRoot}.creating`, JSON.stringify({ pid: process.pid, identity: { startedAt: 'a different legacy timezone' } }));
    assert.match(runResult(root, stateHome, 'recover', 'crashed-recovery', '--force').stderr, /may still be starting/);
    fs.writeFileSync(`${crashedRoot}.creating`, JSON.stringify({ pid: process.pid, identity: { startedAt: 'a different process start', timeBasis: 'utc' } }));
    const preloader = path.join(parent, 'interrupt-recovery.js');
    fs.writeFileSync(preloader, `const fs = require('fs'); const original = fs.mkdtempSync; fs.mkdtempSync = function(prefix, ...args) { const result = original.call(this, prefix, ...args); if (String(prefix).includes('.sidecar-recover-crashed-recovery-')) process.kill(process.pid, 'SIGKILL'); return result; };\n`);
    const crashEnv = { ...process.env, SIDECAR_HOME: stateHome, NODE_OPTIONS: `--require=${JSON.stringify(preloader)}` };
    delete crashEnv.SIDECAR_REGISTRY_HOME;
    const crashedRecovery = runResultWithEnv(root, crashEnv, 'recover', 'crashed-recovery', '--force');
    assert.equal(crashedRecovery.signal, 'SIGKILL');
    const activeGuard = path.join(path.dirname(crashedRoot), `.sidecar-recover-crashed-recovery-${process.pid}-test`);
    fs.mkdirSync(activeGuard);
    assert.match(runResult(root, stateHome, 'recover', 'crashed-recovery', '--force').stderr, /already in progress/);
    fs.rmdirSync(activeGuard);
    const reusedPidGuard = path.join(path.dirname(crashedRoot), `.sidecar-recover-crashed-recovery-${process.pid}-u0000000000000000-test`);
    fs.mkdirSync(reusedPidGuard);
    const retried = run(root, stateHome, 'recover', 'crashed-recovery', '--force');
    const retriedArchive = retried.match(/Preserved interrupted Sidecar files at (.+)\./)[1];
    assert.equal(fs.readFileSync(path.join(retriedArchive, 'work.txt'), 'utf8'), 'preserved after recovery crash');

    fs.rmSync(env.SIDECAR_TEST_READY, { force: true });
    fs.rmSync(env.SIDECAR_TEST_RELEASE, { force: true });
    fs.rmSync(env.SIDECAR_TEST_COPY_DONE, { force: true });
    const interrupt = `
      "$1" "$2" up interrupted > "$3/interrupted.out" 2> "$3/interrupted.err" &
      first=$!
      trap 'touch "$SIDECAR_TEST_RELEASE"; kill "$first" 2>/dev/null || true' EXIT
      attempts=0
      while [ ! -f "$SIDECAR_TEST_READY" ]; do
        attempts=$((attempts + 1)); [ "$attempts" -lt 200 ] || exit 1; sleep 0.05
      done
      kill -9 "$first"
      wait "$first" 2>/dev/null || true
      trap - EXIT
    `;
    const interrupted = spawnSync('sh', ['-c', interrupt, 'sidecar-test', process.execPath, cli, parent], { cwd: root, env, encoding: 'utf8', timeout: 20000 });
    assert.equal(interrupted.status, 0, interrupted.stderr);
    const interruptedRoot = path.dirname(sidecarStatePath(root, stateHome, 'interrupted'));
    fs.writeFileSync(path.join(interruptedRoot, 'work.txt'), 'unfinished');
    const afterInterrupt = run(root, stateHome, 'recover', 'interrupted', '--force');
    const archive = afterInterrupt.match(/Preserved interrupted Sidecar files at (.+)\./)[1];
    assert.equal(fs.readFileSync(path.join(archive, 'work.txt'), 'utf8'), 'unfinished');
    run(root, stateHome, 'up', 'interrupted');
    const replacement = JSON.parse(fs.readFileSync(sidecarStatePath(root, stateHome, 'interrupted'), 'utf8')).view;
    fs.writeFileSync(path.join(replacement, 'file.txt'), 'new work\n');
    fs.writeFileSync(env.SIDECAR_TEST_RELEASE, '');
    for (let attempt = 0; attempt < 200 && !fs.existsSync(env.SIDECAR_TEST_COPY_DONE); attempt += 1) pause(50);
    assert.equal(fs.existsSync(env.SIDECAR_TEST_COPY_DONE), true, 'interrupted copy did not finish');
    assert.equal(fs.readFileSync(path.join(replacement, 'file.txt'), 'utf8'), 'new work\n');
    run(root, stateHome, 'remove', 'interrupted', '--force');
  } finally {
    if (fs.existsSync(path.join(parent, 'ready')) && !fs.existsSync(path.join(parent, 'copy-done'))) {
      fs.writeFileSync(path.join(parent, 'release'), '');
      for (let attempt = 0; attempt < 100 && !fs.existsSync(path.join(parent, 'copy-done')); attempt += 1) pause(50);
    }
    fs.rmSync(parent, { recursive: true, force: true });
  }
}

function startupMutationTest() {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'sidecar-startup-mutation-'));
  const root = path.join(parent, 'project');
  const stateHome = path.join(parent, 'state');
  try {
    fs.mkdirSync(root);
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'sidecar@example.test'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Sidecar Test'], { cwd: root });
    const sidecar = `${JSON.stringify(process.execPath)} ${JSON.stringify(cli)}`;
    fs.writeFileSync(path.join(root, '.sidecar.json'), JSON.stringify({
      version: 1,
      tasks: {
        wait: { command: 'touch "$SIDECAR_TEST_HOOK_READY"; while [ ! -f "$SIDECAR_TEST_HOOK_RELEASE" ]; do sleep 0.05; done' },
        nestedExec: { command: `${sidecar} exec -- sh -c 'printf nested > nested-exec.txt'` },
        nestedTask: { command: `${sidecar} task inner` },
        inner: { command: 'printf nested > nested-task.txt' }
      },
      hooks: { beforeUp: ['wait', 'nestedExec', 'nestedTask'] }
    }));
    fs.writeFileSync(path.join(root, 'file.txt'), 'base\n');
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'base'], { cwd: root });
    const env = { ...process.env, SIDECAR_HOME: stateHome, TZ: 'UTC', SIDECAR_TEST_HOOK_READY: path.join(parent, 'ready'), SIDECAR_TEST_HOOK_RELEASE: path.join(parent, 'release') };
    delete env.SIDECAR_REGISTRY_HOME;
    const script = `
      "$1" "$2" up same > "$3/up.out" 2> "$3/up.err" &
      first=$!
      trap 'touch "$SIDECAR_TEST_HOOK_RELEASE"; kill "$first" 2>/dev/null || true' EXIT
      attempts=0
      while [ ! -f "$SIDECAR_TEST_HOOK_READY" ]; do
        attempts=$((attempts + 1)); [ "$attempts" -lt 200 ] || exit 1; sleep 0.05
      done
      "$1" "$2" status same > /dev/null || exit 1
      for command in down apply watch; do
        if TZ=Asia/Tokyo "$1" "$2" "$command" same > /dev/null 2> "$3/$command.err"; then exit 1; fi
      done
      if TZ=Asia/Tokyo "$1" "$2" remove same --force > /dev/null 2> "$3/remove.err"; then exit 1; fi
      if TZ=Asia/Tokyo "$1" "$2" exec same -- true > /dev/null 2> "$3/exec.err"; then exit 1; fi
      if TZ=Asia/Tokyo "$1" "$2" task same wait > /dev/null 2> "$3/task.err"; then exit 1; fi
      touch "$SIDECAR_TEST_HOOK_RELEASE"
      wait "$first" || exit 1
      trap - EXIT
    `;
    const result = spawnSync('sh', ['-c', script, 'sidecar-test', process.execPath, cli, parent], { cwd: root, env, encoding: 'utf8', timeout: 20000 });
    assert.equal(result.status, 0, result.stderr);
    for (const command of ['down', 'apply', 'watch', 'remove', 'exec', 'task']) {
      assert.match(fs.readFileSync(path.join(parent, `${command}.err`), 'utf8'), /still starting/);
    }
    const state = JSON.parse(fs.readFileSync(sidecarStatePath(root, stateHome, 'same'), 'utf8'));
    assert.equal(fs.readFileSync(path.join(state.view, 'file.txt'), 'utf8'), 'base\n');
    assert.equal(fs.readFileSync(path.join(state.view, 'nested-exec.txt'), 'utf8'), 'nested');
    assert.equal(fs.readFileSync(path.join(state.view, 'nested-task.txt'), 'utf8'), 'nested');
    run(root, stateHome, 'remove', 'same', '--force');
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
}

function interruptedHookIsolationTest() {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'sidecar-old-hook-'));
  const root = path.join(parent, 'project');
  const stateHome = path.join(parent, 'state');
  try {
    fs.mkdirSync(root);
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'sidecar@example.test'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Sidecar Test'], { cwd: root });
    const hook = 'touch "$SIDECAR_TEST_HOOK_READY"; while [ ! -f "$SIDECAR_TEST_HOOK_RELEASE" ]; do sleep 0.05; done; printf old-hook > "$SIDECAR_VIEW/file.txt"; touch "$SIDECAR_TEST_HOOK_DONE"';
    fs.writeFileSync(path.join(root, '.sidecar.json'), JSON.stringify({ version: 1, tasks: { wait: { command: hook } }, hooks: { beforeUp: ['wait'] } }));
    fs.writeFileSync(path.join(root, '.gitignore'), '.sidecar.local.json\n');
    fs.writeFileSync(path.join(root, 'file.txt'), 'base\n');
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'base'], { cwd: root });
    const env = { ...process.env, SIDECAR_HOME: stateHome, SIDECAR_TEST_HOOK_READY: path.join(parent, 'ready'), SIDECAR_TEST_HOOK_RELEASE: path.join(parent, 'release'), SIDECAR_TEST_HOOK_DONE: path.join(parent, 'done') };
    delete env.SIDECAR_REGISTRY_HOME;
    const script = `
      "$1" "$2" up same > "$3/first.out" 2> "$3/first.err" &
      first=$!
      trap 'touch "$SIDECAR_TEST_HOOK_RELEASE"; kill "$first" 2>/dev/null || true' EXIT
      attempts=0
      while [ ! -f "$SIDECAR_TEST_HOOK_READY" ]; do
        attempts=$((attempts + 1)); [ "$attempts" -lt 200 ] || exit 1; sleep 0.05
      done
      "$1" -e 'const fs=require("fs"); fs.writeFileSync(process.argv[2], JSON.parse(fs.readFileSync(process.argv[1], "utf8")).view)' "$4" "$3/old-view" || exit 1
      kill -9 "$first"
      wait "$first" 2>/dev/null || true
      printf '%s' '{"hooks":{"beforeUp":[]}}' > .sidecar.local.json
      "$1" "$2" remove same --force || exit 1
      "$1" "$2" recover same --force || exit 1
      "$1" "$2" up same || exit 1
      "$1" -e 'const fs=require("fs"); fs.writeFileSync(JSON.parse(fs.readFileSync(process.argv[1], "utf8")).view + "/file.txt", "new work\\n")' "$4" || exit 1
      touch "$SIDECAR_TEST_HOOK_RELEASE"
      attempts=0
      while [ ! -f "$SIDECAR_TEST_HOOK_DONE" ]; do
        attempts=$((attempts + 1)); [ "$attempts" -lt 200 ] || exit 1; sleep 0.05
      done
      trap - EXIT
    `;
    const statePath = sidecarStatePath(root, stateHome, 'same');
    const result = spawnSync('sh', ['-c', script, 'sidecar-test', process.execPath, cli, parent, statePath], { cwd: root, env, encoding: 'utf8', timeout: 20000 });
    assert.equal(result.status, 0, result.stderr);
    const replacement = JSON.parse(fs.readFileSync(statePath, 'utf8')).view;
    assert.notEqual(replacement, fs.readFileSync(path.join(parent, 'old-view'), 'utf8'));
    assert.equal(fs.readFileSync(path.join(replacement, 'file.txt'), 'utf8'), 'new work\n');
    run(root, stateHome, 'remove', 'same', '--force');
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
}

function runtimeShellTest() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sidecar-runtime-shell-'));
  const stateHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sidecar-runtime-shell-state-'));
  const shell = path.join(root, 'configured-shell');
  try {
    fs.writeFileSync(shell, '#!/bin/sh\nexport SIDECAR_SHELL_SELECTED="${SIDECAR_SHELL_SELECTED:-}x"\nexec /bin/sh "$@"\n');
    fs.chmodSync(shell, 0o755);
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'sidecar@example.test'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Sidecar Test'], { cwd: root });
    fs.writeFileSync(path.join(root, '.sidecar.json'), JSON.stringify({
      version: 1,
      runtime: { shell },
      tasks: { verifyShell: { command: 'test "$SIDECAR_SHELL_SELECTED" = xx' } }
    }, null, 2));
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'base'], { cwd: root });

    run(root, stateHome, 'up', 'shell-test', '--no-watch', '--no-valet');
    run(root, stateHome, 'task', 'shell-test', 'verifyShell');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(stateHome, { recursive: true, force: true });
  }
}

try {
  storageRootTest();
  console.log('ok - stores sessions in a configured external root and honors SIDECAR_HOME');
  registryOverrideTest();
  console.log('ok - places the registry independently of workspace storage');
  lifecycleTest();
  console.log('ok - creates, diffs, applies, and removes an isolated Sidecar');
  failedStartupTest();
  console.log('ok - cleans up a process when startup hooks fail');
  processSafetyTest();
  console.log('ok - safely stops managed processes and ignores stale process identities');
  invalidShellAndApplySafetyTest();
  console.log('ok - rejects invalid shells and unsafe apply targets without partial changes');
  runtimeShellTest();
  console.log('ok - runs configured commands in the configured shell');
  initTest();
  console.log('ok - initializes only a project configuration');
  noConfigTest();
  console.log('ok - manages a workspace without project configuration');
  discoveryBoundaryTest();
  console.log('ok - respects the Git root and requires an initial commit');
  legacyParentSessionTest();
  console.log('ok - finds legacy parent sessions without overriding local sessions');
  isolationBoundaryTest();
  console.log('ok - protects linked Git metadata and keeps the registry outside the project');
  concurrentStartupTest();
  console.log('ok - protects concurrent startup and recovers interrupted workspaces');
  startupMutationTest();
  console.log('ok - rejects workspace mutations while startup is active');
  interruptedHookIsolationTest();
  console.log('ok - isolates replacement workspaces from interrupted startup hooks');
} catch (error) {
  console.error('not ok - creates, diffs, applies, and removes an isolated Sidecar');
  throw error;
}
