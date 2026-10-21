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
  return spawnSync(process.execPath, [cli, ...args], {
    cwd,
    env: { ...process.env, SIDECAR_HOME: home },
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
    const view = path.join(path.dirname(statePath), 'view');
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
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

    run(root, stateHome, 'up', 'managed', '--no-valet');
    const managedState = JSON.parse(fs.readFileSync(sidecarStatePath(root, stateHome, 'managed'), 'utf8'));
    const managedPid = managedState.processes.watch.pid;
    assert.equal(managedState.processes.watch.identity.pid, managedPid);
    run(root, stateHome, 'down', 'managed');
    for (let attempt = 0; attempt < 20 && processIsAlive(managedPid); attempt += 1) pause(50);
    assert.equal(processIsAlive(managedPid), false);

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
    const view = path.join(path.dirname(sidecarStatePath(root, stateHome, 'apply-safety')), 'view');
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
    assert.equal(fs.existsSync(path.join(root, 'SIDECAR.md')), true);
    assert.match(fs.readFileSync(path.join(root, '.gitignore'), 'utf8'), /^\.sidecar\.local\.json$/m);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(stateHome, { recursive: true, force: true });
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
  console.log('ok - initializes a project configuration and local override ignore rule');
} catch (error) {
  console.error('not ok - creates, diffs, applies, and removes an isolated Sidecar');
  throw error;
}
