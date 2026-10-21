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

The name is optional when run from inside a Sidecar view.`;
}

function safeName(value) {
  const name = String(value || '').toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(name)) {
    fail('Sidecar names must contain lowercase letters, numbers, and hyphens (for example: preview-42).');
  }
  return name;
}

function stateHome() {
  return path.resolve(process.env.SIDECAR_HOME || path.join(os.homedir(), '.sidecar'));
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

function findProject(start = process.cwd()) {
  let current = fs.realpathSync(start);
  while (true) {
    if (fs.existsSync(path.join(current, CONFIG_FILE))) return current;
    const parent = path.dirname(current);
    if (parent === current) fail(`Could not find ${CONFIG_FILE} above ${start}. Run \`sidecar init\` in a project first.`);
    current = parent;
  }
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
  let config;
  try {
    config = read(path.join(projectRoot, CONFIG_FILE));
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

function sessionPaths(projectRoot, name) {
  const root = path.join(stateHome(), 'projects', projectId(projectRoot), 'sessions', name);
  return { root, view: path.join(root, 'view'), state: path.join(root, 'state.json'), logs: path.join(root, 'logs') };
}

function readState(paths) {
  if (!fs.existsSync(paths.state)) fail(`No Sidecar named \`${path.basename(paths.root)}\` exists for this project.`);
  return JSON.parse(fs.readFileSync(paths.state, 'utf8'));
}

function saveState(paths, state) {
  fs.mkdirSync(paths.root, { recursive: true });
  fs.writeFileSync(paths.state, `${JSON.stringify(state, null, 2)}\n`);
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
    ...(state.environment || {})
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

function processIdentity(pid) {
  if (!Number.isInteger(pid) || pid < 1) return null;
  const result = spawnSync('ps', ['-o', 'pid=', '-o', 'pgid=', '-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8' });
  if (result.error || result.status !== 0) return null;
  const match = result.stdout.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
  if (!match) return null;
  return { pid: Number(match[1]), pgid: Number(match[2]), startedAt: match[3] };
}

function wait(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function captureProcessIdentity(pid) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const identity = processIdentity(pid);
    if (identity) return identity;
    wait(PROCESS_POLL_INTERVAL_MS);
  }
  return null;
}

function processMatchesIdentity(processState) {
  if (!processState || !processState.identity) return false;
  const expected = processState.identity;
  if (expected.pid !== processState.pid || expected.pgid !== processState.pid || !expected.startedAt) return false;
  const actual = processIdentity(processState.pid);
  return Boolean(actual && actual.pgid === expected.pgid && actual.startedAt === expected.startedAt);
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
  const gitignore = path.join(process.cwd(), '.gitignore');
  const ignored = fs.existsSync(gitignore) ? fs.readFileSync(gitignore, 'utf8') : '';
  if (!ignored.split(/\r?\n/).includes(LOCAL_CONFIG_FILE)) {
    fs.appendFileSync(gitignore, `${ignored && !ignored.endsWith('\n') ? '\n' : ''}${LOCAL_CONFIG_FILE}\n`);
  }
  const guide = path.join(process.cwd(), GUIDE_FILE);
  if (!fs.existsSync(guide)) {
    fs.writeFileSync(guide, `# Sidecar guide\n\nWork only from \`{view}\`.\n\n## Project-specific steps\n\nDocument repeatable setup, verification, and handoff steps here. Register executable tasks and hooks in \`.sidecar.json\`, then reference them from this guide.\n`);
  }
  console.log(`Created ${target}`);
}

function commandUp(args) {
  const name = safeName(args.shift());
  const noWatch = takeFlag(args, '--no-watch');
  const noValet = takeFlag(args, '--no-valet');
  if (args.length) fail(`Unknown option: ${args[0]}`);
  const projectRoot = findProject();
  const config = loadConfig(projectRoot);
  const paths = sessionPaths(projectRoot, name);
  if (fs.existsSync(paths.state)) fail(`Sidecar \`${name}\` already exists. Use \`sidecar status ${name}\`, or remove it first.`);
  const baseCommit = gitHead(projectRoot);
  const branch = baseCommit ? gitBranch(projectRoot) : null;
  if (baseCommit && git(projectRoot, ['status', '--porcelain']).stdout.trim()) {
    fail('The project root has uncommitted changes. Commit or stash them before creating a Sidecar.');
  }
  fs.mkdirSync(paths.root, { recursive: true });
  let backend;
  let state;
  try {
    backend = createClone(projectRoot, paths.view);
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
    saveState(paths, state);
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
    throw error;
  }
}

function takeFlag(args, flag) {
  const index = args.indexOf(flag);
  if (index === -1) return false;
  args.splice(index, 1);
  return true;
}

function contextFor(name, sidecarContext = findSidecarContext()) {
  const projectRoot = sidecarContext ? sidecarContext.projectRoot : findProject();
  const config = loadConfig(projectRoot);
  const paths = sessionPaths(projectRoot, name);
  const state = readState(paths);
  if (sidecarContext && fs.realpathSync(state.view) !== sidecarContext.view) {
    fail(`Sidecar context does not match the stored view for \`${name}\`.`);
  }
  return { projectRoot, config, paths, state };
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
  const hookError = shutdownSidecar(config, paths, state);
  console.log(`Sidecar ${name} is down. Its view and changes are retained.`);
  if (hookError) throw hookError;
}

function commandRemove(args) {
  const sidecarContext = findSidecarContext();
  const name = nameForCurrentSidecar(args, sidecarContext);
  if (!takeFlag(args, '--force') || args.length) fail('Use: sidecar remove <name> --force');
  const { config, paths, state } = contextFor(name, sidecarContext);
  const hookError = shutdownSidecar(config, paths, state);
  fs.rmSync(paths.root, { recursive: true, force: true });
  console.log(`Removed Sidecar ${name}.`);
  if (hookError) throw hookError;
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
    default: fail(`Unknown command: ${command}\n\n${usage()}`);
  }
}

try {
  main();
} catch (error) {
  console.error(`sidecar: ${error.message}`);
  process.exitCode = 1;
}
