#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const process = require('process');
const { execFileSync, spawn, spawnSync } = require('child_process');

const CONFIG_FILE = '.sidecar.json';
const LOCAL_CONFIG_FILE = '.sidecar.local.json';
const GUIDE_FILE = 'SIDECAR.md';
const STARTUP_TOKEN = Symbol('startupToken');
const STARTUP_TOKEN_ENV = 'SIDECAR_STARTUP_TOKEN';
const PROCESS_STOP_TIMEOUT_MS = 5000;
const PROCESS_POLL_INTERVAL_MS = 50;

function fail(message) {
  throw new Error(message);
}

function usage() {
  return `Sidecar — isolated development workspaces

Usage:
  sidecar init
  sidecar up <name> [--no-watch] [--no-valet]
  sidecar watch [name] [process]
  sidecar exec [name] -- <command> [args...]
  sidecar task [name] <task> [-- <args...>]
  sidecar guide [name]
  sidecar status [name]
  sidecar diff [name]
  sidecar apply [name]
  sidecar down [name]
  sidecar remove [name] --force
  sidecar recover <name> --force [--clear-recovery-lock | --clear-registry] [--unverified]

The name is optional when run from inside a Sidecar view.`;
}

function safeName(value) {
  const name = String(value || '').toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(name)) {
    fail('Sidecar names must contain lowercase letters, numbers, and hyphens (for example: preview-42).');
  }
  return name;
}

function isObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function merge(base, override) {
  const output = { ...base };
  for (const [key, value] of Object.entries(override || {})) {
    output[key] = isObject(value) && isObject(base[key]) ? merge(base[key], value) : value;
  }
  return output;
}

function gitOutputPath(output) {
  return output.endsWith('\n') ? output.slice(0, -1) : output;
}

function findProject(start = process.cwd()) {
  let current = fs.realpathSync(start);
  const result = spawnSync('git', ['-C', current, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  const gitPath = gitOutputPath(result.stdout || '');
  const gitRoot = result.status === 0 && gitPath ? fs.realpathSync(gitPath) : null;
  while (true) {
    if (fs.existsSync(path.join(current, CONFIG_FILE))) return current;
    const parent = path.dirname(current);
    if (current === gitRoot || parent === current) break;
    current = parent;
  }
  if (gitRoot) return gitRoot;
  fail(`Could not find a Git project or ${CONFIG_FILE} above ${start}. Run \`sidecar init\` to configure a project without Git.`);
}

function findSidecarContext(start = process.cwd()) {
  let current = fs.realpathSync(start);
  while (true) {
    const statePath = path.join(path.dirname(current), 'state.json');
    if (fs.existsSync(statePath)) {
      try {
        const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
        if (state.name && state.projectRoot && state.view && fs.realpathSync(state.view) === current) {
          return { name: safeName(state.name), projectRoot: state.projectRoot, view: current };
        }
      } catch (_) {}
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function loadConfig(projectRoot) {
  const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
  let config = { version: 1 };
  try {
    const configPath = path.join(projectRoot, CONFIG_FILE);
    if (fs.existsSync(configPath)) config = read(configPath);
  } catch (error) {
    fail(`Could not read ${CONFIG_FILE}: ${error.message}`);
  }
  const local = path.join(projectRoot, LOCAL_CONFIG_FILE);
  if (fs.existsSync(local)) {
    try {
      config = merge(config, read(local));
    } catch (error) {
      fail(`Could not read ${LOCAL_CONFIG_FILE}: ${error.message}`);
    }
  }
  if (config.version !== 1) fail(`${CONFIG_FILE} must set \"version\": 1.`);
  if (config.storage !== undefined && !isObject(config.storage)) {
    fail('storage must be an object.');
  }
  if (config.storage && config.storage.root !== undefined && (typeof config.storage.root !== 'string' || !config.storage.root.trim())) {
    fail('storage.root must be a non-empty path string.');
  }
  if (config.runtime && config.runtime.bootstrap && !Array.isArray(config.runtime.bootstrap)) {
    fail('runtime.bootstrap must be an array of shell commands.');
  }
  if (config.runtime && config.runtime.shell && typeof config.runtime.shell !== 'string') {
    fail('runtime.shell must be a shell path or command name.');
  }
  if (config.runtime && config.runtime.bootstrap && config.runtime.bootstrap.some((command) => typeof command !== 'string')) {
    fail('runtime.bootstrap must contain only shell commands.');
  }
  for (const [name, definition] of Object.entries(config.processes || {})) {
    if (!definition || typeof definition.command !== 'string') fail(`processes.${name}.command must be a string.`);
    if (definition.shutdownTimeoutMs !== undefined && (!Number.isInteger(definition.shutdownTimeoutMs) || definition.shutdownTimeoutMs < 1)) {
      fail(`processes.${name}.shutdownTimeoutMs must be a positive integer.`);
    }
  }
  return config;
}

function projectId(projectRoot) {
  return crypto.createHash('sha256').update(projectRoot).digest('hex').slice(0, 16);
}

function canonicalPath(target) {
  let existing = target;
  const missing = [];
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    missing.unshift(path.basename(existing));
    existing = parent;
  }
  return path.join(fs.realpathSync(existing), ...missing);
}

function stateHome(projectRoot, config) {
  const configuredRoot = config.storage && config.storage.root;
  const root = process.env.SIDECAR_HOME
    ? path.resolve(process.env.SIDECAR_HOME)
    : configuredRoot
      ? path.resolve(projectRoot, configuredRoot)
      : path.join(os.homedir(), '.sidecar');
  const resolvedRoot = canonicalPath(root);
  if (resolvedRoot === projectRoot || resolvedRoot.startsWith(`${projectRoot}${path.sep}`)) {
    fail('Sidecar storage must be outside the project root to prevent a Sidecar from cloning itself.');
  }
  return root;
}

function sessionPaths(projectRoot, config, name) {
  const root = path.join(stateHome(projectRoot, config), 'projects', projectId(projectRoot), 'sessions', name);
  return pathsForRoot(root);
}

function pathsForRoot(root) {
  return { root, view: path.join(root, 'view'), state: path.join(root, 'state.json'), logs: path.join(root, 'logs'), claim: `${root}.creating` };
}

function isSessionView(paths, view) {
  return view === paths.view || (typeof view === 'string'
    && path.dirname(view) === paths.root && /^view-[0-9a-f]{32}$/.test(path.basename(view)));
}

function claimStartup(paths, name) {
  const parent = path.dirname(paths.root);
  fs.mkdirSync(parent, { recursive: true });
  const temporary = fs.mkdtempSync(path.join(parent, '.sidecar-claim-'));
  const token = crypto.randomBytes(24).toString('hex');
  try {
    const owner = path.join(temporary, 'owner.json');
    const contents = JSON.stringify({ pid: process.pid, identity: processIdentity(process.pid), token });
    fs.writeFileSync(owner, contents);
    try {
      fs.linkSync(owner, paths.claim);
    } catch (error) {
      if (!['ENOTSUP', 'EOPNOTSUPP', 'EPERM', 'ENOSYS'].includes(error.code)) throw error;
      const descriptor = fs.openSync(paths.claim, 'wx');
      try {
        fs.writeFileSync(descriptor, contents);
      } catch (writeError) {
        fs.closeSync(descriptor);
        fs.rmSync(paths.claim, { force: true });
        throw writeError;
      }
      fs.closeSync(descriptor);
    }
  } catch (error) {
    if (error.code === 'EEXIST') fail(`Sidecar \`${name}\` is already being created, or its startup was interrupted. Use \`sidecar recover ${name} --force\` after confirming it is no longer running.`);
    throw error;
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
  return token;
}

function registryPath(projectRoot, name) {
  const home = process.env.SIDECAR_REGISTRY_HOME
    ? path.resolve(process.env.SIDECAR_REGISTRY_HOME)
    : process.env.SIDECAR_HOME
      ? path.resolve(process.env.SIDECAR_HOME)
      : path.join(os.homedir(), '.sidecar');
  const resolvedHome = canonicalPath(home);
  if (resolvedHome === projectRoot || resolvedHome.startsWith(`${projectRoot}${path.sep}`)) {
    fail('Sidecar registry must be outside the project root. Set SIDECAR_HOME to a directory outside the project.');
  }
  return path.join(home, 'registry', projectId(projectRoot), `${name}.json`);
}

function registeredPaths(projectRoot, name) {
  const file = registryPath(projectRoot, name);
  if (!fs.existsSync(file)) return null;
  let record;
  try { record = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) { fail(`Could not read Sidecar registry: ${error.message}. After confirming no startup is running, use \`sidecar recover ${name} --force --clear-registry --unverified\`.`); }
  if (typeof record.root !== 'string' || !path.isAbsolute(record.root)) fail('Invalid Sidecar registry entry.');
  const paths = pathsForRoot(record.root);
  if (!fs.existsSync(paths.state)) fail(`Sidecar \`${name}\` is registered at ${paths.root}, but its state is missing. After checking the original storage and confirming no startup is running, use \`sidecar recover ${name} --force --clear-registry --unverified\`.`);
  const state = readState(paths);
  if (state.name !== name || state.projectRoot !== projectRoot || !isSessionView(paths, state.view)) fail('Sidecar registry entry does not match its state.');
  paths.view = state.view;
  return paths;
}

function registerSession(projectRoot, name, paths) {
  const file = registryPath(projectRoot, name);
  const parent = path.dirname(file);
  fs.mkdirSync(parent, { recursive: true });
  const temporary = fs.mkdtempSync(path.join(parent, '.registry-'));
  try {
    const entry = path.join(temporary, 'entry.json');
    const contents = `${JSON.stringify({ root: paths.root })}\n`;
    fs.writeFileSync(entry, contents);
    try {
      fs.linkSync(entry, file);
    } catch (error) {
      if (!['ENOTSUP', 'EOPNOTSUPP', 'EPERM', 'ENOSYS'].includes(error.code)) throw error;
      let descriptor = fs.openSync(file, 'wx');
      try {
        fs.writeFileSync(descriptor, contents);
        fs.closeSync(descriptor);
        descriptor = null;
      } catch (writeError) {
        if (descriptor !== null) {
          try { fs.closeSync(descriptor); } catch (_) { /* preserve the write or close error */ }
        }
        fs.rmSync(file, { force: true });
        throw writeError;
      }
    }
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

function readState(paths) {
  if (!fs.existsSync(paths.state)) fail(`No Sidecar named \`${path.basename(paths.root)}\` exists for this project.`);
  return JSON.parse(fs.readFileSync(paths.state, 'utf8'));
}

function saveState(paths, state) {
  fs.mkdirSync(paths.root, { recursive: true });
  const temporary = fs.mkdtempSync(path.join(paths.root, '.state-'));
  try {
    const file = path.join(temporary, 'state.json');
    fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`);
    fs.renameSync(file, paths.state);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

function git(projectRoot, args, options = {}) {
  const result = spawnSync('git', ['-C', projectRoot, ...args], { encoding: 'utf8', ...options });
  if (result.error) fail(`Could not run git: ${result.error.message}`);
  if (result.status !== 0 && !options.allowFailure) fail(result.stderr.trim() || 'Git command failed.');
  return result;
}

function gitHead(projectRoot) {
  const result = git(projectRoot, ['rev-parse', 'HEAD'], { allowFailure: true });
  return result.status === 0 ? result.stdout.trim() : null;
}

function gitBranch(projectRoot) {
  const result = git(projectRoot, ['branch', '--show-current'], { allowFailure: true });
  return result.status === 0 && result.stdout.trim() ? result.stdout.trim() : '(detached)';
}

function render(value, context) {
  if (typeof value !== 'string') return value;
  return value.replace(/\{(name|branch|domain|url|view)\}/g, (_whole, key) => context[key] || '');
}

function renderValetDomain(template, context) {
  if (/\{(?:domain|url|view)\}/.test(template)) {
    fail('valet.domain supports only the {name} and {branch} placeholders.');
  }
  return render(template, context);
}

function domainSafeBranch(branch) {
  const slug = String(branch || 'detached').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || 'detached';
}

function stateContext(state) {
  return { name: state.name, branch: state.branch || '(detached)', domain: state.domain, url: state.url, view: state.view };
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\\"'\\\"'")}'`;
}

function sidecarEnvironment(state) {
  return {
    ...process.env,
    SIDECAR_NAME: state.name,
    SIDECAR_BRANCH: state.branch || '',
    SIDECAR_DOMAIN: state.domain || '',
    SIDECAR_URL: state.url || '',
    SIDECAR_VIEW: state.view,
    ...(state.environment || {}),
    ...(state[STARTUP_TOKEN] ? { [STARTUP_TOKEN_ENV]: state[STARTUP_TOKEN] } : {})
  };
}

function shellFor(config) {
  return (config.runtime && config.runtime.shell) || process.env.SHELL || '/bin/sh';
}

function bootstrapFor(config) {
  return ((config.runtime && config.runtime.bootstrap) || []).join('\n');
}

function buildCommandScript(config) {
  const bootstrap = bootstrapFor(config);
  return `${bootstrap}${bootstrap ? '\n' : ''}exec ${shellQuote(shellFor(config))} -lc "$1"`;
}

function runConfiguredCommand(config, state, command, { detached = false, logFile } = {}) {
  const stdout = fs.openSync(logFile, 'a');
  const stderr = fs.openSync(logFile, 'a');
  let child;
  try {
    child = spawn(shellFor(config), ['-lc', buildCommandScript(config), 'sidecar', command], {
      cwd: state.view,
      env: sidecarEnvironment(state),
      detached,
      stdio: ['ignore', stdout, stderr]
    });
  } finally {
    fs.closeSync(stdout);
    fs.closeSync(stderr);
  }
  // spawn() reports launch failures asynchronously; keep that event from becoming an unhandled error
  // while startProcess attaches its state-cleanup listener below.
  child.once('error', () => {});
  if (detached) child.unref();
  return child;
}

function runExactCommand(config, state, command, args) {
  const bootstrap = bootstrapFor(config);
  const script = `${bootstrap}${bootstrap ? '\n' : ''}exec "$@"`;
  const result = spawnSync(shellFor(config), ['-lc', script, 'sidecar', command, ...args], {
    cwd: state.view,
    env: sidecarEnvironment(state),
    stdio: 'inherit'
  });
  if (result.error) fail(result.error.message);
  if (result.signal) {
    console.error(`sidecar: command was terminated by ${result.signal}.`);
    process.exitCode = 128 + (os.constants.signals[result.signal] || 1);
    return;
  }
  process.exitCode = Number.isInteger(result.status) ? result.status : 1;
}

function processIdentity(pid, legacy = false) {
  if (!Number.isInteger(pid) || pid < 1) return null;
  const env = legacy ? process.env : { ...process.env, TZ: 'UTC', LC_ALL: 'C' };
  const result = spawnSync('ps', ['-o', 'pid=', '-o', 'pgid=', '-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', env });
  if (result.error || result.status !== 0) return null;
  const match = result.stdout.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
  if (!match) return null;
  return { pid: Number(match[1]), pgid: Number(match[2]), startedAt: match[3], ...(legacy ? {} : { timeBasis: 'utc' }) };
}

function processIsRecordedOwner(owner) {
  try {
    process.kill(owner.pid, 0);
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
  if (owner.identity && owner.identity.timeBasis === 'utc' && owner.identity.startedAt) {
    const actual = processIdentity(owner.pid);
    if (actual && actual.startedAt !== owner.identity.startedAt) return false;
  }
  return true;
}

function identityFingerprint(identity) {
  return identity && identity.timeBasis === 'utc' && identity.startedAt
    ? `u${crypto.createHash('sha256').update(identity.startedAt).digest('hex').slice(0, 16)}`
    : 'unknown';
}

function wait(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function captureProcessIdentity(pid) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const legacy = processIdentity(pid, true);
    const utc = processIdentity(pid);
    if (legacy && utc && legacy.pid === utc.pid && legacy.pgid === utc.pgid) {
      return { ...legacy, utcStartedAt: utc.startedAt };
    }
    wait(PROCESS_POLL_INTERVAL_MS);
  }
  return null;
}

function processMatchesIdentity(processState) {
  if (!processState || !processState.identity) return false;
  const expected = processState.identity;
  if (expected.pid !== processState.pid || expected.pgid !== processState.pid || !expected.startedAt) return false;
  const hasUtc = typeof expected.utcStartedAt === 'string' || expected.timeBasis === 'utc';
  const actual = processIdentity(processState.pid, !hasUtc);
  const expectedStart = typeof expected.utcStartedAt === 'string' ? expected.utcStartedAt : expected.startedAt;
  return Boolean(actual && actual.pgid === expected.pgid && actual.startedAt === expectedStart);
}

function waitForProcessExit(processState, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (processMatchesIdentity(processState) && Date.now() < deadline) wait(PROCESS_POLL_INTERVAL_MS);
  return !processMatchesIdentity(processState);
}

function stopManagedProcess(processName, processState) {
  if (!processMatchesIdentity(processState)) {
    console.warn(`Not stopping ${processName}: its recorded process identity no longer matches.`);
    return false;
  }
  try {
    process.kill(-processState.pid, 'SIGTERM');
  } catch (error) {
    if (error.code !== 'ESRCH') console.warn(`Could not stop ${processName}: ${error.message}`);
    return error.code === 'ESRCH';
  }
  const timeoutMs = processState.shutdownTimeoutMs || PROCESS_STOP_TIMEOUT_MS;
  if (waitForProcessExit(processState, timeoutMs)) return true;
  console.warn(`${processName} did not stop after ${timeoutMs}ms; sending SIGKILL.`);
  try {
    process.kill(-processState.pid, 'SIGKILL');
  } catch (error) {
    if (error.code !== 'ESRCH') console.warn(`Could not force-stop ${processName}: ${error.message}`);
    return error.code === 'ESRCH';
  }
  return waitForProcessExit(processState, timeoutMs);
}

function stopManagedProcesses(state) {
  for (const [processName, processState] of Object.entries(state.processes || {})) {
    if (stopManagedProcess(processName, processState)) console.log(`Stopped ${processName} (PID ${processState.pid}).`);
    delete state.processes[processName];
  }
}

function ensureCommand(command) {
  const result = spawnSync('sh', ['-lc', `command -v ${command}`], { stdio: 'ignore' });
  if (result.status !== 0) fail(`Required command not found: ${command}`);
}

function ensureShell(shell) {
  if (!shell || typeof shell !== 'string') fail('A valid runtime.shell is required.');
  if (shell.includes(path.sep)) {
    try {
      fs.accessSync(shell, fs.constants.X_OK);
    } catch (_) {
      fail(`Configured shell is not executable: ${shell}`);
    }
    return;
  }
  const result = spawnSync('sh', ['-lc', 'command -v "$1"', 'sidecar', shell], { stdio: 'ignore' });
  if (result.status !== 0) fail(`Configured shell was not found: ${shell}`);
}

function createClone(projectRoot, view) {
  fs.mkdirSync(path.dirname(view), { recursive: true });
  try {
    execFileSync('cp', ['-cR', `${projectRoot}/.`, view], { stdio: 'pipe' });
    return 'apfs-clone';
  } catch (_) {
    execFileSync('cp', ['-R', `${projectRoot}/.`, view], { stdio: 'pipe' });
    return 'copy';
  }
}

function valetLinkPath(domain) {
  return path.join(os.homedir(), '.config', 'valet', 'Sites', domain);
}

function linkValet(config, state) {
  if (!config.valet || config.valet.enabled === false) return false;
  ensureCommand('valet');
  const args = ['link'];
  if (config.valet.secure) args.push('--secure');
  if (config.valet.isolate) args.push('--isolate');
  args.push(state.domain);
  const result = spawnSync('valet', args, { cwd: state.view, encoding: 'utf8' });
  if (result.status !== 0) fail(result.stderr.trim() || `Valet could not link ${state.domain}.`);
  return true;
}

function unlinkValet(state) {
  if (!state.valetLinked) return;
  const link = valetLinkPath(state.domain);
  if (!fs.existsSync(link)) return;
  let pointsToView = false;
  try { pointsToView = fs.realpathSync(link) === fs.realpathSync(state.view); } catch (_) { /* leave the link alone */ }
  if (!pointsToView) {
    console.warn(`Not unlinking ${state.domain}: its Valet link no longer points to this Sidecar.`);
    return;
  }
  const result = spawnSync('valet', ['unlink', state.domain], { encoding: 'utf8' });
  if (result.status !== 0) console.warn(`Could not unlink ${state.domain}: ${result.stderr.trim()}`);
}

function defaultProcess(config) {
  if (config.processes && config.processes.watch) return 'watch';
  return Object.entries(config.processes || {}).find(([, processDefinition]) => processDefinition.autostart)?.[0];
}

function startProcess(projectRoot, config, paths, state, processName) {
  const definition = (config.processes || {})[processName];
  if (!definition) fail(`No process named \`${processName}\` is configured.`);
  state.processes = state.processes || {};
  if (processMatchesIdentity(state.processes[processName])) {
    console.log(`${processName} is already running (PID ${state.processes[processName].pid}).`);
    return;
  }
  delete state.processes[processName];
  ensureShell(shellFor(config));
  const command = render(definition.command, stateContext(state));
  fs.mkdirSync(paths.logs, { recursive: true });
  const logFile = path.join(paths.logs, `${processName}.log`);
  const child = runConfiguredCommand(config, state, command, { detached: true, logFile });
  if (!child.pid) fail(`Could not start ${processName}.`);
  const identity = captureProcessIdentity(child.pid);
  if (!identity || identity.pgid !== child.pid) fail(`Could not verify ownership of ${processName} (PID ${child.pid}).`);
  state.processes[processName] = {
    command,
    pid: child.pid,
    identity,
    logFile,
    startedAt: new Date().toISOString(),
    shutdownTimeoutMs: definition.shutdownTimeoutMs
  };
  child.once('error', (error) => {
    if (state.processes[processName] && state.processes[processName].pid === child.pid) {
      delete state.processes[processName];
      try { saveState(paths, state); } catch (_) { /* state cleanup is best effort */ }
    }
    console.error(`sidecar: ${processName} could not start: ${error.message}`);
  });
  saveState(paths, state);
  console.log(`Started ${processName} (PID ${child.pid}).`);
}

function runTask(config, paths, state, taskName, taskArgs = []) {
  const definition = (config.tasks || {})[taskName];
  if (!definition) fail(`No task named \`${taskName}\` is configured.`);
  const command = typeof definition === 'string' ? definition : definition.command;
  if (typeof command !== 'string') fail(`tasks.${taskName}.command must be a string.`);
  const rendered = render(command, stateContext(state));
  const commandWithArgs = [rendered, ...taskArgs.map(shellQuote)].join(' ');
  ensureShell(shellFor(config));
  const result = spawnSync(shellFor(config), ['-lc', buildCommandScript(config), 'sidecar', commandWithArgs], {
    cwd: state.view,
    env: sidecarEnvironment(state),
    stdio: 'inherit'
  });
  if (result.error) fail(result.error.message);
  if (result.status !== 0) fail(`Task \`${taskName}\` exited with status ${result.status}.`);
}

function runHooks(config, paths, state, hookName) {
  for (const taskName of (config.hooks && config.hooks[hookName]) || []) runTask(config, paths, state, taskName);
}

function shutdownSidecar(config, paths, state) {
  let hookError;
  try { runHooks(config, paths, state, 'beforeDown'); } catch (error) { hookError = error; }
  stopManagedProcesses(state);
  unlinkValet(state);
  state.stoppedAt = new Date().toISOString();
  saveState(paths, state);
  try { runHooks(config, paths, state, 'afterDown'); } catch (error) { hookError = hookError || error; }
  return hookError;
}

function assertReadyToApply(projectRoot, state) {
  if (gitHead(projectRoot) !== state.baseCommit) {
    fail('The project HEAD changed since this Sidecar started. Reconcile the Sidecar manually rather than applying into a moving base.');
  }
  if (git(projectRoot, ['status', '--porcelain']).stdout.trim()) {
    fail('The project root has uncommitted changes. Commit, stash, or clean it before applying a Sidecar.');
  }
}

function commandInit() {
  const target = path.join(process.cwd(), CONFIG_FILE);
  if (fs.existsSync(target)) fail(`${CONFIG_FILE} already exists here.`);
  const template = fs.readFileSync(path.join(__dirname, '..', '.sidecar.example.json'), 'utf8');
  fs.writeFileSync(target, template);
  console.log(`Created ${target}`);
}

function commandUp(args) {
  const name = safeName(args.shift());
  const noWatch = takeFlag(args, '--no-watch');
  const noValet = takeFlag(args, '--no-valet');
  if (args.length) fail(`Unknown option: ${args[0]}`);
  const projectRoot = findProject();
  const config = loadConfig(projectRoot);
  const gitRootResult = git(projectRoot, ['rev-parse', '--show-toplevel'], { allowFailure: true });
  if (gitRootResult.status === 0) {
    const gitRoot = fs.realpathSync(gitOutputPath(gitRootResult.stdout));
    if (projectRoot !== gitRoot) {
      fail('A Sidecar project cannot be a subdirectory of a Git checkout: its workspace would not have Git metadata. Put .sidecar.json at the Git root instead.');
    }
    const gitEntry = path.join(gitRoot, '.git');
    if (fs.existsSync(gitEntry) && !fs.lstatSync(gitEntry).isDirectory()) {
      fail('Git linked worktrees, submodules, and linked Git metadata are not supported: their Git metadata is shared outside the workspace. Use a standalone checkout.');
    }
  }
  const paths = sessionPaths(projectRoot, config, name);
  if (registeredPaths(projectRoot, name) || fs.existsSync(paths.state)) fail(`Sidecar \`${name}\` already exists. Use \`sidecar status ${name}\`, or remove it first.`);
  const baseCommit = gitHead(projectRoot);
  if (!baseCommit && git(projectRoot, ['rev-parse', '--is-inside-work-tree'], { allowFailure: true }).status === 0) {
    fail('This Git project has no commits. Create an initial commit before creating a Sidecar.');
  }
  const branch = baseCommit ? gitBranch(projectRoot) : null;
  if (baseCommit && git(projectRoot, ['status', '--porcelain']).stdout.trim()) {
    fail('The project root has uncommitted changes. Commit or stash them before creating a Sidecar.');
  }
  const startupToken = claimStartup(paths, name);
  try {
    fs.mkdirSync(paths.root);
  } catch (error) {
    fs.rmSync(paths.claim, { force: true });
    if (error.code === 'EEXIST') {
      fail(`Sidecar \`${name}\` has an existing session directory at ${paths.root}. After confirming no startup is running, use \`sidecar recover ${name} --force\`.`);
    }
    throw error;
  }
  let backend;
  let state;
  let registered = false;
  try {
    paths.view = path.join(paths.root, `view-${crypto.randomBytes(16).toString('hex')}`);
    const attempt = fs.mkdtempSync(path.join(paths.root, '.creating-view-'));
    const attemptView = path.join(attempt, 'view');
    backend = createClone(projectRoot, attemptView);
    fs.renameSync(attemptView, paths.view);
    fs.rmdirSync(attempt);
    const valetEnabled = Boolean(config.valet && config.valet.enabled !== false && !noValet);
    const domain = valetEnabled ? renderValetDomain(config.valet.domain || '{name}.test', { name, branch: domainSafeBranch(branch), domain: '', url: '', view: paths.view }) : '';
    state = {
      version: 1,
      name,
      projectRoot,
      baseCommit,
      branch,
      backend,
      createdAt: new Date().toISOString(),
      view: paths.view,
      domain,
      url: domain ? `${config.valet.secure ? 'https' : 'http'}://${domain}` : '',
      valetLinked: false,
      processes: {}
    };
    state[STARTUP_TOKEN] = startupToken;
    saveState(paths, state);
    registerSession(projectRoot, name, paths);
    registered = true;
    runHooks(config, paths, state, 'beforeUp');
    if (valetEnabled) state.valetLinked = linkValet(config, state);
    saveState(paths, state);
    if (!noWatch) {
      const processName = defaultProcess(config);
      if (processName) startProcess(projectRoot, config, paths, state, processName);
    }
    runHooks(config, paths, state, 'afterUp');
    console.log(`\nSidecar ${name} is ready.`);
    if (state.url) console.log(`URL:  ${state.url}`);
    console.log(`View: ${state.view}`);
    console.log(`Mode: ${backend === 'apfs-clone' ? 'APFS copy-on-write clone' : 'isolated copy'}`);
  } catch (error) {
    if (state) {
      stopManagedProcesses(state);
      unlinkValet(state);
    }
    fs.rmSync(paths.root, { recursive: true, force: true });
    const registry = registryPath(projectRoot, name);
    if (registered && fs.existsSync(registry)) {
      try {
        if (JSON.parse(fs.readFileSync(registry, 'utf8')).root === paths.root) fs.unlinkSync(registry);
      } catch (_) { /* preserve an unreadable registry entry */ }
    }
    throw error;
  } finally {
    fs.rmSync(paths.claim, { force: true });
  }
}

function takeFlag(args, flag) {
  const index = args.indexOf(flag);
  if (index === -1) return false;
  args.splice(index, 1);
  return true;
}

function findLegacyParentSession(projectRoot, name) {
  const home = path.resolve(process.env.SIDECAR_HOME || path.join(os.homedir(), '.sidecar'));
  let current = path.dirname(projectRoot);
  while (true) {
    if (fs.existsSync(path.join(current, CONFIG_FILE))) {
      const paths = pathsForRoot(path.join(home, 'projects', projectId(current), 'sessions', name));
      if (fs.existsSync(paths.state)) {
        const state = readState(paths);
        if (state.name === name && state.projectRoot === current && isSessionView(paths, state.view)) {
          paths.view = state.view;
          return { projectRoot: current, config: loadConfig(current), paths, state };
        }
      }
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function contextFor(name, sidecarContext = findSidecarContext()) {
  const projectRoot = sidecarContext ? sidecarContext.projectRoot : findProject();
  const config = loadConfig(projectRoot);
  const paths = registeredPaths(projectRoot, name)
    || (sidecarContext && sidecarContext.name === name ? pathsForRoot(path.dirname(sidecarContext.view)) : sessionPaths(projectRoot, config, name));
  if (!sidecarContext && !fs.existsSync(paths.state)) {
    const legacy = findLegacyParentSession(projectRoot, name);
    if (legacy) return legacy;
  }
  const state = readState(paths);
  if (sidecarContext && fs.realpathSync(state.view) !== sidecarContext.view) {
    fail(`Sidecar context does not match the stored view for \`${name}\`.`);
  }
  return { projectRoot, config, paths, state };
}

function assertNotStarting(paths, name, allowStartupToken = false) {
  if (!fs.existsSync(paths.claim)) return;
  let owner;
  try { owner = JSON.parse(fs.readFileSync(paths.claim, 'utf8')); } catch (_) { fail(`Cannot verify whether Sidecar \`${name}\` is still starting.`); }
  if (!owner || !Number.isInteger(owner.pid) || owner.pid < 1) fail(`Cannot verify whether Sidecar \`${name}\` is still starting.`);
  if (processIsRecordedOwner(owner)) {
    if (allowStartupToken && owner.token && process.env[STARTUP_TOKEN_ENV] === owner.token) return;
    fail(`Sidecar \`${name}\` is still starting. Wait for startup to finish.`);
  }
}

function nameForCurrentSidecar(args, sidecarContext) {
  if (args[0] && args[0] !== '--') return safeName(args.shift());
  if (sidecarContext) return sidecarContext.name;
  return safeName(args.shift());
}

function commandWatch(args) {
  const sidecarContext = findSidecarContext();
  const explicitCurrentName = sidecarContext && args[0] && args[0].toLowerCase() === sidecarContext.name;
  const name = explicitCurrentName ? safeName(args.shift()) : (sidecarContext ? sidecarContext.name : safeName(args.shift()));
  const processName = args.shift();
  if (args.length) fail(`Unknown argument: ${args[0]}`);
  const context = contextFor(name, sidecarContext);
  assertNotStarting(context.paths, name);
  startProcess(context.projectRoot, context.config, context.paths, context.state, processName || defaultProcess(context.config));
}

function commandExec(args) {
  const sidecarContext = findSidecarContext();
  const name = nameForCurrentSidecar(args, sidecarContext);
  const separator = args.indexOf('--');
  if (separator === -1 || separator === args.length - 1) fail('Use: sidecar exec <name> -- <command> [args...]');
  if (separator !== 0) fail('Use: sidecar exec <name> -- <command> [args...]');
  const commandArgs = args.slice(separator + 1);
  const context = contextFor(name, sidecarContext);
  assertNotStarting(context.paths, name, true);
  ensureShell(shellFor(context.config));
  runExactCommand(context.config, context.state, commandArgs[0], commandArgs.slice(1));
}

function commandTask(args) {
  const sidecarContext = findSidecarContext();
  const explicitCurrentName = sidecarContext && args.length > 1 && args[0].toLowerCase() === sidecarContext.name;
  const name = explicitCurrentName ? safeName(args.shift()) : (sidecarContext ? sidecarContext.name : safeName(args.shift()));
  const taskName = args.shift();
  const separator = args.indexOf('--');
  if (!taskName || (separator !== -1 && separator !== 0) || (separator === -1 && args.length)) {
    fail('Use: sidecar task [name] <task> [-- <args...>]');
  }
  const taskArgs = separator === -1 ? [] : args.slice(1);
  const context = contextFor(name, sidecarContext);
  assertNotStarting(context.paths, name, true);
  runTask(context.config, context.paths, context.state, taskName, taskArgs);
}

function commandGuide(args) {
  const sidecarContext = findSidecarContext();
  const name = nameForCurrentSidecar(args, sidecarContext);
  if (args.length) fail('Use: sidecar guide <name>');
  const { projectRoot, config, state } = contextFor(name, sidecarContext);
  const guide = (config.agent && config.agent.guide) || GUIDE_FILE;
  const guidePath = path.resolve(projectRoot, guide);
  if (!guidePath.startsWith(`${projectRoot}${path.sep}`) || !fs.existsSync(guidePath)) {
    fail(`No Sidecar guide found at ${guide}. Add one to the project or set agent.guide in ${CONFIG_FILE}.`);
  }
  process.stdout.write(render(fs.readFileSync(guidePath, 'utf8'), stateContext(state)));
}

function commandStatus(args) {
  const sidecarContext = findSidecarContext();
  const name = nameForCurrentSidecar(args, sidecarContext);
  if (args.length) fail(`Unknown argument: ${args[0]}`);
  const { state } = contextFor(name, sidecarContext);
  console.log(`Sidecar: ${state.name}`);
  console.log(`View:    ${state.view}`);
  console.log(`Mode:    ${state.backend}`);
  console.log(`Base:    ${state.baseCommit || 'not a Git repository'}`);
  if (state.branch) console.log(`Branch:  ${state.branch}`);
  if (state.url) console.log(`URL:     ${state.url}`);
  const processes = Object.entries(state.processes || {});
  if (!processes.length) console.log('Processes: none');
  for (const [processName, processState] of processes) {
    console.log(`${processName}: ${processMatchesIdentity(processState) ? 'running' : 'stopped'} (PID ${processState.pid})`);
    if (processState.logFile) console.log(`  Log: ${processState.logFile}`);
  }
}

function commandDiff(args) {
  const sidecarContext = findSidecarContext();
  const name = nameForCurrentSidecar(args, sidecarContext);
  if (args.length) fail(`Unknown argument: ${args[0]}`);
  const { state } = contextFor(name, sidecarContext);
  if (!state.baseCommit) fail('Diff requires a Git repository.');
  const result = git(state.view, ['diff', '--stat', state.baseCommit]);
  process.stdout.write(result.stdout);
  const untracked = git(state.view, ['status', '--short', '--untracked-files=all']);
  if (untracked.stdout) {
    console.log('Untracked files:');
    process.stdout.write(untracked.stdout);
  }
}

function lstatIfExists(target) {
  try {
    return fs.lstatSync(target);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    fail(`Could not inspect apply target ${target}: ${error.message}`);
  }
}

function assertSafeApplyTarget(projectRoot, relativePath, target) {
  if (!target.startsWith(`${projectRoot}${path.sep}`)) fail(`Cannot apply untracked file safely: ${relativePath}`);
  if (lstatIfExists(target)) fail(`Cannot apply untracked file safely: ${relativePath}`);
  let parent = path.dirname(target);
  while (parent !== projectRoot) {
    const parentStat = lstatIfExists(parent);
    if (parentStat && (!parentStat.isDirectory() || parentStat.isSymbolicLink())) {
      fail(`Cannot apply untracked file through an unsafe parent path: ${relativePath}`);
    }
    parent = path.dirname(parent);
  }
}

function commandApply(args) {
  const sidecarContext = findSidecarContext();
  const name = nameForCurrentSidecar(args, sidecarContext);
  if (args.length) fail(`Unknown argument: ${args[0]}`);
  const { projectRoot, config, paths, state } = contextFor(name, sidecarContext);
  assertNotStarting(paths, name);
  if (!state.baseCommit) fail('Apply requires a Git repository.');
  assertReadyToApply(projectRoot, state);
  runHooks(config, paths, state, 'beforeApply');
  assertReadyToApply(projectRoot, state);
  const untrackedResult = git(state.view, ['ls-files', '--others', '--exclude-standard', '-z']);
  const untracked = untrackedResult.stdout.split('\0').filter(Boolean);
  const untrackedEntries = untracked.map((relativePath) => {
    const source = path.join(state.view, relativePath);
    const target = path.resolve(projectRoot, relativePath);
    assertSafeApplyTarget(projectRoot, relativePath, target);
    const sourceStat = fs.lstatSync(source);
    if (!sourceStat.isFile() && !sourceStat.isSymbolicLink()) fail(`Cannot apply unsupported untracked file type: ${relativePath}`);
    return { relativePath, source, target, sourceStat };
  });
  const patch = git(state.view, ['diff', '--binary', state.baseCommit]).stdout;
  if (patch) {
    const applied = spawnSync('git', ['-C', projectRoot, 'apply', '--whitespace=nowarn'], { input: patch, encoding: 'utf8' });
    if (applied.status !== 0) fail(applied.stderr.trim() || 'Could not apply Sidecar patch cleanly.');
  }
  for (const entry of untrackedEntries) {
    fs.mkdirSync(path.dirname(entry.target), { recursive: true });
    if (entry.sourceStat.isSymbolicLink()) {
      fs.symlinkSync(fs.readlinkSync(entry.source), entry.target);
    } else {
      fs.copyFileSync(entry.source, entry.target);
      fs.chmodSync(entry.target, entry.sourceStat.mode & 0o7777);
    }
  }
  state.appliedAt = new Date().toISOString();
  saveState(paths, state);
  runHooks(config, paths, state, 'afterApply');
  console.log(`Applied Sidecar ${name} to ${projectRoot}.`);
}

function commandDown(args) {
  const sidecarContext = findSidecarContext();
  const name = nameForCurrentSidecar(args, sidecarContext);
  if (args.length) fail(`Unknown argument: ${args[0]}`);
  const { config, paths, state } = contextFor(name, sidecarContext);
  assertNotStarting(paths, name);
  const hookError = shutdownSidecar(config, paths, state);
  console.log(`Sidecar ${name} is down. Its view and changes are retained.`);
  if (hookError) throw hookError;
}

function commandRemove(args) {
  const sidecarContext = findSidecarContext();
  const force = takeFlag(args, '--force');
  const name = nameForCurrentSidecar(args, sidecarContext);
  if (!force || args.length) fail('Use: sidecar remove <name> --force');
  const { config, paths, state } = contextFor(name, sidecarContext);
  assertNotStarting(paths, name);
  const hookError = shutdownSidecar(config, paths, state);
  fs.rmSync(paths.root, { recursive: true, force: true });
  fs.rmSync(registryPath(state.projectRoot, name), { force: true });
  console.log(`Removed Sidecar ${name}.`);
  if (hookError) throw hookError;
}

function commandRecover(args) {
  const name = safeName(args.shift());
  const force = takeFlag(args, '--force');
  const clearLock = takeFlag(args, '--clear-recovery-lock');
  const clearRegistry = takeFlag(args, '--clear-registry');
  const unverified = takeFlag(args, '--unverified');
  if (!force || args.length || (clearLock && clearRegistry)) fail('Use: sidecar recover <name> --force [--clear-recovery-lock | --clear-registry] [--unverified]');
  const projectRoot = findProject();
  const config = loadConfig(projectRoot);
  const paths = sessionPaths(projectRoot, config, name);
  const recoveryLock = `${paths.claim}.recovering`;
  const recoveryOwner = path.join(recoveryLock, 'owner.json');
  const parent = path.dirname(paths.root);
  const guardPrefix = `.sidecar-recover-${name}-`;
  fs.mkdirSync(parent, { recursive: true });
  const guard = fs.mkdtempSync(path.join(parent, `${guardPrefix}${process.pid}-${identityFingerprint(processIdentity(process.pid))}-`));
  let ownClaim = false;
  try {
    for (const entry of fs.readdirSync(parent)) {
      if (!entry.startsWith(guardPrefix) || entry === path.basename(guard)) continue;
      const match = entry.slice(guardPrefix.length).match(/^(\d+)-(?:(\w+)-)?[A-Za-z0-9]+$/);
      if (!match) continue;
      const pid = Number(match[1]);
      if (!Number.isSafeInteger(pid) || pid < 1) continue;
      try {
        process.kill(pid, 0);
        if (match[2] && /^u[0-9a-f]{16}$/.test(match[2])) {
          const identity = processIdentity(pid);
          if (identity && identityFingerprint(identity) !== match[2]) continue;
        }
        fail(`Recovery for Sidecar \`${name}\` is already in progress (PID ${pid}).`);
      } catch (error) {
        if (error.code !== 'ESRCH') throw error;
      }
    }
    if (clearRegistry) {
      if (!unverified) fail('After confirming no startup for this name is running, repeat with --unverified to preserve and clear the unreadable registry entry.');
      if (fs.existsSync(paths.claim)) {
        let owner;
        try { owner = JSON.parse(fs.readFileSync(paths.claim, 'utf8')); } catch (_) { /* manual verification is required above */ }
        if (owner && Number.isInteger(owner.pid) && owner.pid > 0 && processIsRecordedOwner(owner)) {
          fail(`Sidecar \`${name}\` may still be starting (PID ${owner.pid}). Wait for it to finish before clearing the registry.`);
        }
      }
      const file = registryPath(projectRoot, name);
      if (!fs.existsSync(file)) fail(`No registry entry exists for Sidecar \`${name}\`.`);
      let record;
      try { record = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) { if (!(error instanceof SyntaxError)) throw error; }
      if (record && typeof record.root === 'string' && path.isAbsolute(record.root)) {
        if (fs.existsSync(record.root)) fail(`The registry points to an existing session directory at ${record.root}; inspect it before clearing the entry.`);
        const recordedClaim = pathsForRoot(record.root).claim;
        if (fs.existsSync(recordedClaim)) {
          let owner;
          try { owner = JSON.parse(fs.readFileSync(recordedClaim, 'utf8')); } catch (_) { /* manual verification is required above */ }
          if (owner && Number.isInteger(owner.pid) && owner.pid > 0 && processIsRecordedOwner(owner)) {
            fail(`Sidecar \`${name}\` may still be starting (PID ${owner.pid}). Wait for it to finish before clearing the registry.`);
          }
        }
      }
      const archive = fs.mkdtempSync(path.join(path.dirname(file), `.recovered-registry-${name}-`));
      try {
        fs.renameSync(file, path.join(archive, 'entry.json'));
      } catch (error) {
        fs.rmdirSync(archive);
        throw error;
      }
      console.log(`Preserved the registry entry at ${path.join(archive, 'entry.json')}.`);
      return;
    }
    if (clearLock) {
      if (!fs.existsSync(recoveryLock)) fail(`No recovery lock exists for Sidecar \`${name}\`.`);
      let owner;
      try { owner = JSON.parse(fs.readFileSync(recoveryOwner, 'utf8')); } catch (_) { /* older or interrupted locks may have no owner */ }
      if (!owner || !Number.isInteger(owner.pid) || owner.pid < 1) {
        if (!unverified) fail('Cannot verify the recovery lock owner. After confirming no recovery is running, repeat with --unverified.');
      } else {
        if (processIsRecordedOwner(owner)) fail(`Recovery may still be running (PID ${owner.pid}). Wait for it to finish before clearing the lock.`);
      }
      fs.rmSync(recoveryLock, { recursive: true });
      console.log(`Cleared the recovery lock for Sidecar ${name}. Run recovery again.`);
      return;
    }
    if (fs.existsSync(recoveryLock)) fail(`Recovery for Sidecar \`${name}\` was interrupted. After confirming no recovery is running, use \`sidecar recover ${name} --force --clear-recovery-lock\`.`);
    const checkState = () => {
      if (!fs.existsSync(paths.state)) return;
      let state;
      try { state = JSON.parse(fs.readFileSync(paths.state, 'utf8')); } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
      }
      if (state && state.name === name && state.projectRoot === projectRoot && isSessionView(paths, state.view)) {
        fail(`Sidecar \`${name}\` has state. Use \`sidecar status ${name}\` or \`sidecar remove ${name} --force\`.`);
      }
      if (!unverified) fail('Cannot verify the Sidecar state. After confirming no startup or managed processes are running, repeat with --unverified to preserve the workspace.');
    };
    checkState();
    if (fs.existsSync(paths.claim)) {
      let owner;
      try { owner = JSON.parse(fs.readFileSync(paths.claim, 'utf8')); } catch (_) { /* an interrupted fallback claim may be incomplete */ }
      if (!owner || !Number.isInteger(owner.pid) || owner.pid < 1) {
        if (!unverified) fail('Cannot verify the startup owner. After confirming no startup is running, repeat with --unverified.');
      } else {
        if (processIsRecordedOwner(owner)) fail(`Sidecar \`${name}\` may still be starting (PID ${owner.pid}). Wait for it to finish before recovering.`);
      }
    } else {
      if (!fs.existsSync(paths.root)) fail(`No interrupted Sidecar named \`${name}\` was found.`);
      claimStartup(paths, name);
      ownClaim = true;
    }
    checkState();
    let registryNeedsCheck = false;
    if (fs.existsSync(paths.root)) {
      const archive = fs.mkdtempSync(path.join(path.dirname(paths.root), `.recovered-${name}-`));
      try {
        fs.renameSync(paths.root, path.join(archive, 'session'));
      } catch (error) {
        fs.rmdirSync(archive);
        throw error;
      }
      console.log(`Preserved interrupted Sidecar files at ${path.join(archive, 'session')}.`);
      const file = registryPath(projectRoot, name);
      if (fs.existsSync(file)) {
        registryNeedsCheck = true;
        console.log(`If the registry still refers to this workspace, clear it with \`sidecar recover ${name} --force --clear-registry --unverified\` after checking the original storage.`);
      }
    }
    fs.rmSync(paths.claim, { force: true });
    ownClaim = false;
    if (!registryNeedsCheck) console.log(`Sidecar ${name} can now be created again.`);
  } finally {
    if (ownClaim) fs.rmSync(paths.claim, { force: true });
    fs.rmdirSync(guard);
  }
}

function main() {
  const args = process.argv.slice(2);
  const command = args.shift();
  if (!command || command === '--help' || command === '-h' || command === 'help') {
    console.log(usage());
    return;
  }
  switch (command) {
    case 'init': return commandInit();
    case 'up': return commandUp(args);
    case 'watch': return commandWatch(args);
    case 'exec': return commandExec(args);
    case 'task': return commandTask(args);
    case 'guide': return commandGuide(args);
    case 'status': return commandStatus(args);
    case 'diff': return commandDiff(args);
    case 'apply': return commandApply(args);
    case 'down': return commandDown(args);
    case 'remove': return commandRemove(args);
    case 'recover': return commandRecover(args);
    default: fail(`Unknown command: ${command}\n\n${usage()}`);
  }
}

try {
  main();
} catch (error) {
  console.error(`sidecar: ${error.message}`);
  process.exitCode = 1;
}
