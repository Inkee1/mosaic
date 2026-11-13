import { spawn as spawnProcess } from 'node:child_process';
import { access, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, dirname, extname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { StringDecoder } from 'node:string_decoder';

export function abortError() {
  const error = new Error('AI run was stopped.');
  error.name = 'AbortError';
  return error;
}
export function safeError(error) {
  return String(error?.message || error || 'Provider failed')
    .replace(/(?:Bearer\s+|sk-(?:ant-)?)[A-Za-z0-9._-]+/gi, '[redacted]')
    .replace(
      /("?(?:access_token|refresh_token|api_key|authorization)"?\s*[:=]\s*)[^\s,}]+/gi,
      '$1[redacted]',
    )
    .slice(0, 1800);
}
const exists = async (path) => {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
};

export async function resolveNode(env = process.env) {
  for (const directory of (env.PATH || env.Path || '').split(delimiter)) {
    const file = join(
      directory.replace(/^"|"$/g, ''),
      process.platform === 'win32' ? 'node.exe' : 'node',
    );
    if (await exists(file)) return file;
  }
  return process.execPath;
}

// Never execute npm's .cmd/.ps1 wrappers through a shell. Resolve the known
// package binary, or use the official JavaScript entry with Node directly.
export async function resolveProviderCommand(provider, env = process.env) {
  const windows = process.platform === 'win32';
  const roots = [
    ...(env.PATH || env.Path || '').split(delimiter),
    ...(windows
      ? [
          join(env.APPDATA || join(homedir(), 'AppData/Roaming'), 'npm'),
          join(homedir(), '.local/bin'),
        ]
      : []),
  ]
    .filter(Boolean)
    .map((p) => p.replace(/^"|"$/g, ''));
  for (const directory of [...new Set(roots)]) {
    const direct = join(directory, windows ? provider + '.exe' : provider);
    if (await exists(direct)) {
      const path = await realpath(direct);
      if (windows || !['.js', '.mjs'].includes(extname(path))) return { command: path, args: [] };
      return { command: await resolveNode(env), args: [path] };
    }
    const packageRoot = join(
      directory,
      'node_modules',
      provider === 'codex' ? '@openai/codex' : '@anthropic-ai/claude-code',
    );
    if (provider === 'claude') {
      const native = join(packageRoot, 'bin', windows ? 'claude.exe' : 'claude');
      if (await exists(native)) return { command: native, args: [] };
      const script = join(packageRoot, 'cli.js');
      if (await exists(script)) return { command: await resolveNode(env), args: [script] };
    } else {
      if (windows) {
        const target = (process.arch === 'arm64' ? 'aarch64' : 'x86_64') + '-pc-windows-msvc';
        for (const vendor of [
          join(packageRoot, 'node_modules/@openai/codex-win32-' + process.arch, 'vendor'),
          join(directory, 'node_modules/@openai/codex-win32-' + process.arch, 'vendor'),
          join(packageRoot, 'vendor'),
        ]) {
          const native = join(vendor, target, 'bin/codex.exe');
          if (await exists(native)) return { command: native, args: [] };
        }
      }
      const script = join(packageRoot, 'bin/codex.js');
      if (await exists(script)) return { command: await resolveNode(env), args: [script] };
    }
  }
  return null;
}

export class ProviderProcess {
  constructor(
    command,
    args,
    {
      cwd,
      env,
      spawn = spawnProcess,
      requestTimeout = 20000,
      shutdownTimeout = 1800,
      onClose = () => {},
    } = {},
  ) {
    this.requestTimeout = requestTimeout;
    this.shutdownTimeout = shutdownTimeout;
    this.pending = new Map();
    this.listeners = new Set();
    this.nextId = 0;
    this.stderr = '';
    this.buffer = '';
    this.decoder = new StringDecoder('utf8');
    this.failure = null;
    this.closed = false;
    this.spawn = spawn;
    this.child = spawn(command, [...args], {
      cwd,
      env,
      windowsHide: true,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    this.exited = new Promise((resolveExit) => {
      this.child.once('close', (code, signal) => {
        this.closed = true;
        this.exitCode = code;
        this.fail(
          this.failure ||
            new Error(
              'Provider exited' +
                (code ? ' (' + code + ')' : '') +
                (this.stderr ? ': ' + safeError(this.stderr) : '') +
                '.',
            ),
        );
        resolveExit({ code, signal });
        onClose(this);
      });
      this.child.once('error', (error) => {
        this.fail(error);
      });
    });
    this.child.stdin.on('error', (error) => {
      if (!this.stopping) this.fail(error);
    });
    this.child.stdout.on('data', (data) => {
      this.buffer += this.decoder.write(data);
      if (this.buffer.length > 16 * 1024 * 1024) {
        this.fail(new Error('Provider message exceeded the size limit.'));
        void this.stop();
        return;
      }
      let at;
      while ((at = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, at).trim();
        this.buffer = this.buffer.slice(at + 1);
        if (!line) continue;
        let value;
        try {
          value = JSON.parse(line);
        } catch {
          this.fail(new Error('Provider returned invalid JSON.'));
          void this.stop();
          return;
        }
        this.receive(value);
      }
    });
    this.child.stderr.on('data', (data) => {
      this.stderr = (this.stderr + data.toString()).slice(-4000);
    });
  }
  receive(value) {
    const isClaude = value.type === 'control_response';
    const id = isClaude ? value.response?.request_id : value.id;
    if (id !== undefined && this.pending.has(id) && (!value.method || isClaude)) {
      const pending = this.pending.get(id);
      this.pending.delete(id);
      clearTimeout(pending.timer);
      const error = isClaude
        ? value.response?.subtype === 'error'
          ? value.response?.error
          : null
        : value.error;
      error
        ? pending.reject(new Error(safeError(error)))
        : pending.resolve(isClaude ? value.response?.response : value.result);
      return;
    }
    for (const fn of this.listeners) {
      try {
        fn(value);
      } catch (error) {
        this.fail(error);
      }
    }
  }
  send(value) {
    if (this.closed || this.child.stdin.destroyed)
      throw this.failure || new Error('Provider process is closed.');
    this.child.stdin.write(JSON.stringify(value) + '\n');
  }
  request(method, params = {}, claude = false) {
    if (this.failure) return Promise.reject(this.failure);
    const id = claude ? 'mosaic-' + ++this.nextId : ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('Provider request timed out: ' + method));
      }, this.requestTimeout);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send(
          claude
            ? { type: 'control_request', request_id: id, request: { subtype: method, ...params } }
            : { id, method, params },
        );
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }
  fail(error) {
    if (this.failure) return;
    this.failure = error;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    this.pending.clear();
    for (const fn of this.listeners) {
      try {
        fn({ type: 'mosaic_process_error', error });
      } catch {}
    }
  }
  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  async stop(interrupt) {
    if (this.stopping) return this.stopping;
    this.stopping = (async () => {
      if (this.closed) return;
      try {
        if (interrupt) this.send(interrupt);
      } catch {}
      try {
        this.child.stdin.end();
      } catch {}
      let timer;
      await Promise.race([
        this.exited,
        new Promise((resolveWait) => {
          timer = setTimeout(resolveWait, this.shutdownTimeout);
        }),
      ]);
      clearTimeout(timer);
      if (this.closed) return;
      if (process.platform === 'win32' && this.child.pid) {
        await new Promise((resolveKill) => {
          const kill = this.spawn(
            join(process.env.SystemRoot || 'C:/Windows', 'System32/taskkill.exe'),
            ['/PID', String(this.child.pid), '/T', '/F'],
            { windowsHide: true, shell: false, stdio: 'ignore' },
          );
          kill.once('error', resolveKill);
          kill.once('close', resolveKill);
        });
      } else {
        try {
          process.kill(-this.child.pid, 'SIGKILL');
        } catch {
          try {
            this.child.kill('SIGKILL');
          } catch {}
        }
      }
      // Never release pane locks while an owned provider is still alive.
      await this.exited;
    })();
    return this.stopping;
  }
}

export async function capture(
  command,
  args,
  {
    cwd,
    env,
    spawn = spawnProcess,
    timeout = 15000,
    signal,
    onProcess = () => {},
    onClose = () => {},
  } = {},
) {
  if (signal?.aborted) throw abortError();
  const child = spawn(command, args, {
    cwd,
    env,
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  });
  let stdout = '',
    stderr = '',
    timedOut = false,
    aborted = false,
    failure;
  const handle = { closed: false };
  const exited = new Promise((resolveExit) => {
    child.once('error', (error) => {
      failure = error;
    });
    child.once('close', (code) => {
      handle.closed = true;
      resolveExit(code);
      onClose(handle);
    });
  });
  handle.stop = () => {
    if (handle.stopping) return handle.stopping;
    handle.stopping = (async () => {
      if (handle.closed) return;
      aborted = true;
      if (process.platform === 'win32' && child.pid) {
        await new Promise((done) => {
          const kill = spawn(
            join(process.env.SystemRoot || 'C:/Windows', 'System32/taskkill.exe'),
            ['/PID', String(child.pid), '/T', '/F'],
            { windowsHide: true, shell: false, stdio: 'ignore' },
          );
          kill.once('error', done);
          kill.once('close', done);
        });
      } else {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          child.kill('SIGKILL');
        }
      }
      await exited;
    })();
    return handle.stopping;
  };
  child.stdout.on('data', (data) => {
    stdout = (stdout + data).slice(-1024 * 1024);
  });
  child.stderr.on('data', (data) => {
    stderr = (stderr + data).slice(-4000);
  });
  onProcess(handle);
  const abort = () => {
    void handle.stop();
  };
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    void handle.stop();
  }, timeout);
  try {
    const code = await exited;
    if (failure) throw failure;
    if (timedOut) throw new Error('Provider discovery timed out.');
    if (aborted) throw abortError();
    return { code, stdout, stderr };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}
