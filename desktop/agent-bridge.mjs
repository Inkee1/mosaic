import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AGENT_TOOLS, validAgentId, validateCall } from './agent-tools.mjs';

const execFileAsync = promisify(execFile);
const BODY_LIMIT = 128 * 1024;
const DEADLINE_MS = 30_000;
const MAX_WAITING = 64;
const MAX_PANE_WAITING = 16;
const MAX_ACTIVE = 3;
const GLOBAL_LANE = '$list';

class BridgeError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

async function privateFile(path) {
  if (process.platform !== 'win32') {
    await chmod(path, 0o600);
    return;
  }
  // Restrict the empty file before it receives the bearer token. POSIX mode bits
  // alone do not restrict inherited Windows ACLs. No machine policy is changed.
  const { stdout } = await execFileAsync('whoami.exe', ['/user', '/fo', 'csv', '/nh'], {
    windowsHide: true,
  });
  const sid = stdout.match(/\bS-1-[0-9-]+\b/)?.[0];
  if (!sid) throw new Error('Cannot determine the current user for the private connection file.');
  await execFileAsync('icacls.exe', [path, '/inheritance:r', '/grant:r', '*' + sid + ':(F)'], {
    windowsHide: true,
  });
}

async function writeConnection(path, contents) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = path + '.' + randomBytes(8).toString('hex') + '.tmp';
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await privateFile(temporary);
    await handle.writeFile(JSON.stringify(contents) + '\n', 'utf8');
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
  } finally {
    await handle?.close().catch(() => {});
    await unlink(temporary).catch(() => {});
  }
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0,
      done = false;
    const finish = (error, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      request.off('data', data);
      request.off('end', end);
      request.off('aborted', aborted);
      request.off('error', failed);
      if (error) {
        request.resume();
        reject(error);
      } else resolve(value);
    };
    const data = (chunk) => {
      bytes += chunk.length;
      if (bytes > BODY_LIMIT) {
        finish(new BridgeError('BODY_TOO_LARGE', 'Request body exceeds 128 KiB.', 413));
        return;
      }
      chunks.push(chunk);
    };
    const end = () => {
      try {
        finish(null, JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        finish(new BridgeError('INVALID_JSON', 'Request body must be valid JSON.'));
      }
    };
    const aborted = () =>
      finish(new BridgeError('CLIENT_DISCONNECTED', 'Client disconnected.', 499));
    const failed = () => finish(new BridgeError('INVALID_REQUEST', 'Could not read request body.'));
    const timer = setTimeout(
      () => finish(new BridgeError('REQUEST_TIMEOUT', 'Request body timed out.', 408)),
      10_000,
    );
    timer.unref();
    request.on('data', data);
    request.on('end', end);
    request.on('aborted', aborted);
    request.on('error', failed);
  });
}

/** The supplied executor must call guard immediately before every external
 * side effect, including after any await. Guards remain invalid after stop,
 * grant removal, timeout, disconnect or close, even if access is later resumed. */
export class AgentBridge {
  #execute;
  #getProfile;
  #emit;
  #token = '';
  #server;
  #connectionFile;
  #enabled = false;
  #closed = false;
  #grants = new Map();
  #paused = new Set();
  #generations = new Map();
  #generation = 0;
  #queue = [];
  #active = new Map();
  #sequence = 0;
  #lastClient;
  #port = null;
  #starting;
  #closePromise;

  constructor({ execute, getProfile, emit = () => {} }) {
    if (
      typeof execute !== 'function' ||
      typeof getProfile !== 'function' ||
      typeof emit !== 'function'
    )
      throw new TypeError('Bridge requires execute and getProfile functions.');
    this.#execute = execute;
    this.#getProfile = getProfile;
    this.#emit = emit;
  }

  async start(connectionFile) {
    this.#assertOpen();
    if (this.#server) throw new Error('Agent bridge has already started.');
    if (typeof connectionFile !== 'string' || !connectionFile)
      throw new TypeError('A connection file path is required.');
    this.#connectionFile = resolve(connectionFile);
    this.#token = randomBytes(32).toString('hex');
    const server = http.createServer(
      { maxHeaderSize: 8192, requestTimeout: 15_000, headersTimeout: 10_000 },
      (request, response) => {
        void this.#handle(request, response);
      },
    );
    this.#server = server;
    server.keepAliveTimeout = 1_000;
    server.maxRequestsPerSocket = 100;
    this.#starting = (async () => {
      await new Promise((done, fail) => {
        server.once('error', fail);
        server.listen(0, '127.0.0.1', () => {
          server.off('error', fail);
          done();
        });
      });
      this.#port = server.address().port;
      this.#assertOpen();
      await writeConnection(this.#connectionFile, {
        url: 'http://127.0.0.1:' + this.#port,
        token: this.#token,
        pid: process.pid,
      });
      this.#assertOpen();
      return this.info();
    })();
    try {
      return await this.#starting;
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  setAccess({ enabled, panes }) {
    this.#assertOpen();
    if (typeof enabled !== 'boolean' || !Array.isArray(panes) || panes.length > 100)
      throw new TypeError('Access requires enabled and an array of pane grants.');
    const next = new Map();
    for (const pane of panes) {
      if (!pane || !validAgentId(pane.id) || !validAgentId(pane.profileId) || next.has(pane.id))
        throw new TypeError('Invalid or duplicate pane grant.');
      if (this.#profile(pane.id) !== pane.profileId)
        throw new BridgeError(
          'GRANT_CHANGED',
          'Pane profile no longer matches the requested grant.',
          403,
        );
      next.set(pane.id, pane.profileId);
    }
    const changed = new Set(
      [...this.#grants.keys(), ...next.keys()].filter(
        (id) => this.#grants.get(id) !== next.get(id),
      ),
    );
    for (const id of changed) {
      this.#bump(id);
      this.#paused.delete(id);
    }
    this.#grants = next;
    this.#enabled = enabled;
    if (!enabled) this.#generation++;
    this.#cancelWhere(
      (job) => !enabled || (job.paneId && changed.has(job.paneId)),
      new BridgeError('ACCESS_REVOKED', 'Pane access was revoked or changed.', 403),
    );
    this.#event('access');
    return this.info();
  }

  stop(paneId) {
    if (this.#closed) return this.info();
    if (paneId !== undefined) {
      if (!validAgentId(paneId)) throw new TypeError('Invalid pane ID.');
      this.#bump(paneId);
      if (this.#grants.has(paneId)) this.#paused.add(paneId);
    } else {
      this.#generation++;
      this.#enabled = false;
    }
    this.#cancelWhere(
      (job) => paneId === undefined || job.paneId === paneId,
      new BridgeError('STOPPED', 'Agent work was stopped by the user.', 409),
    );
    this.#event('stopped', { ...(paneId === undefined ? {} : { paneId }) });
    return this.info();
  }

  resume(paneId) {
    this.#assertOpen();
    if (!validAgentId(paneId)) throw new TypeError('Invalid pane ID.');
    this.#checkAccess(paneId, true);
    this.#paused.delete(paneId);
    this.#event('resumed', { paneId });
    return this.info();
  }

  info() {
    const allowedPaneIds = [...this.#grants]
      .filter(([id, profile]) => this.#profile(id) === profile)
      .map(([id]) => id);
    return {
      enabled: this.#enabled && !this.#closed,
      allowedPaneIds,
      pausedPaneIds: allowedPaneIds.filter((id) => this.#paused.has(id)),
      port: this.#port,
      connectionFile: this.#connectionFile ?? null,
      ...(this.#lastClient ? { lastClient: this.#lastClient } : {}),
      activeCount: this.#active.size,
    };
  }

  close() {
    if (this.#closePromise) return this.#closePromise;
    this.#closed = true;
    this.#enabled = false;
    this.#generation++;
    this.#cancelWhere(() => true, new BridgeError('BRIDGE_CLOSED', 'Agent bridge is closed.', 503));
    this.#closePromise = (async () => {
      await this.#starting?.catch(() => {});
      const server = this.#server;
      if (server?.listening)
        await new Promise((done) => {
          server.close(done);
          server.closeAllConnections();
        });
      if (this.#connectionFile) {
        try {
          const saved = JSON.parse(await readFile(this.#connectionFile, 'utf8'));
          if (saved.token === this.#token && saved.pid === process.pid)
            await unlink(this.#connectionFile);
        } catch (error) {
          if (error.code !== 'ENOENT' && !(error instanceof SyntaxError))
            this.#event('failed', { code: 'CONNECTION_CLEANUP_FAILED' });
        }
      }
      this.#port = null;
    })();
    return this.#closePromise;
  }

  #assertOpen() {
    if (this.#closed) throw new BridgeError('BRIDGE_CLOSED', 'Agent bridge is closed.', 503);
  }
  #profile(id) {
    try {
      return this.#getProfile(id);
    } catch {
      return undefined;
    }
  }
  #bump(id) {
    this.#generations.set(id, (this.#generations.get(id) ?? 0) + 1);
  }
  #checkAccess(paneId, allowPaused = false) {
    this.#assertOpen();
    if (!this.#enabled)
      throw new BridgeError('ACCESS_DISABLED', 'Enable agent access in Mosaic first.', 403);
    if (!paneId) return;
    if (!this.#grants.has(paneId))
      throw new BridgeError('ACCESS_DENIED', 'This pane has not been granted to the agent.', 403);
    if (this.#profile(paneId) !== this.#grants.get(paneId))
      throw new BridgeError(
        'GRANT_CHANGED',
        'Pane profile changed; the user must grant access again.',
        403,
      );
    if (!allowPaused && this.#paused.has(paneId))
      throw new BridgeError('PANE_PAUSED', 'The user paused agent control of this pane.', 409);
  }

  #event(phase, metadata = {}) {
    try {
      this.#emit({
        type: 'agent',
        phase,
        at: new Date().toISOString(),
        ...metadata,
        info: this.info(),
      });
    } catch {
      /* A UI listener must not interrupt cancellation or scheduling. */
    }
  }

  #publicError(error) {
    const known = error instanceof BridgeError;
    const message = typeof error?.message === 'string' ? error.message : 'Agent command failed.';
    return {
      code: known ? error.code : 'ACTION_FAILED',
      message: message
        .split(this.#token || '\0')
        .join('[redacted]')
        .slice(0, 300),
    };
  }

  #guard(job) {
    if (job.error) throw job.error;
    if (
      job.settled ||
      job.generation !== this.#generation ||
      job.paneGeneration !== (this.#generations.get(job.paneId) ?? 0)
    )
      throw new BridgeError('STOPPED', 'This command is no longer active.', 409);
    if (Date.now() >= job.deadline)
      throw new BridgeError(
        'DEADLINE_EXCEEDED',
        'Agent command exceeded its 30-second deadline.',
        504,
      );
    this.#checkAccess(job.paneId);
    if (job.paneId && this.#grants.get(job.paneId) !== job.profileId)
      throw new BridgeError('GRANT_CHANGED', 'The pane grant changed.', 403);
  }

  #settle(job, error, result) {
    if (job.settled) return;
    job.settled = true;
    job.error = error;
    clearTimeout(job.timer);
    this.#queue = this.#queue.filter((queued) => queued !== job);
    if (error) job.reject(error);
    else job.resolve(result);
    this.#event(error ? 'failed' : 'completed', {
      operationId: job.id,
      method: job.method,
      ...(job.paneId ? { paneId: job.paneId } : {}),
      ...(error ? this.#publicError(error) : {}),
    });
  }

  #cancelWhere(predicate, error) {
    for (const job of [...this.#queue, ...this.#active.values()])
      if (predicate(job)) this.#settle(job, error);
    this.#drain();
  }

  #enqueue(method, args) {
    const paneId = args.paneId;
    this.#checkAccess(paneId);
    const lane = paneId ?? GLOBAL_LANE;
    if (
      this.#queue.length >= MAX_WAITING ||
      this.#queue.filter((job) => job.lane === lane).length >= MAX_PANE_WAITING
    )
      throw new BridgeError(
        'QUEUE_FULL',
        'Agent command queue is full. Wait for active commands to finish.',
        429,
      );
    const job = {
      id: ++this.#sequence,
      method,
      args,
      paneId,
      lane,
      profileId: this.#grants.get(paneId),
      generation: this.#generation,
      paneGeneration: this.#generations.get(paneId) ?? 0,
      deadline: Date.now() + DEADLINE_MS,
      settled: false,
    };
    const promise = new Promise((resolve, reject) => {
      job.resolve = resolve;
      job.reject = reject;
    });
    job.timer = setTimeout(() => {
      this.#settle(
        job,
        new BridgeError('DEADLINE_EXCEEDED', 'Agent command exceeded its 30-second deadline.', 504),
      );
      this.#drain();
    }, DEADLINE_MS);
    job.timer.unref();
    this.#queue.push(job);
    this.#event('queued', { operationId: job.id, method, ...(paneId ? { paneId } : {}) });
    this.#drain();
    return {
      promise,
      cancel: () => {
        this.#settle(job, new BridgeError('CLIENT_DISCONNECTED', 'Client disconnected.', 499));
        this.#drain();
      },
    };
  }

  #drain() {
    while (this.#active.size < MAX_ACTIVE) {
      const index = this.#queue.findIndex((job) => !this.#active.has(job.lane));
      if (index < 0) return;
      const [job] = this.#queue.splice(index, 1);
      try {
        this.#guard(job);
      } catch (error) {
        this.#settle(job, error);
        continue;
      }
      this.#active.set(job.lane, job);
      void this.#run(job);
    }
  }

  async #run(job) {
    this.#event('started', {
      operationId: job.id,
      method: job.method,
      ...(job.paneId ? { paneId: job.paneId } : {}),
    });
    try {
      this.#guard(job);
      let result = await this.#execute(job.method, job.args, () => this.#guard(job));
      this.#guard(job);
      if (job.method === 'list_panes') {
        if (!Array.isArray(result)) throw new Error('Pane executor returned an invalid list.');
        result = result.filter((pane) => {
          const id = pane?.id ?? pane?.paneId;
          return (
            this.#grants.has(id) &&
            pane.profileId === this.#grants.get(id) &&
            this.#profile(id) === pane.profileId
          );
        });
      }
      this.#settle(job, null, result ?? null);
    } catch (error) {
      this.#settle(job, error);
    } finally {
      // A timed-out or stopped executor keeps its lane until it actually exits.
      // Otherwise a resumed command could race an in-flight browser operation.
      this.#active.delete(job.lane);
      this.#drain();
      this.#event('state');
    }
  }

  #authenticate(request) {
    const authorization = request.headers.authorization;
    const expected = Buffer.from('Bearer ' + this.#token);
    const actual = Buffer.from(typeof authorization === 'string' ? authorization : '');
    const counts = {};
    for (let i = 0; i < request.rawHeaders.length; i += 2) {
      const name = request.rawHeaders[i].toLowerCase();
      counts[name] = (counts[name] ?? 0) + 1;
    }
    if (
      counts.authorization !== 1 ||
      actual.length !== expected.length ||
      !timingSafeEqual(actual, expected)
    )
      throw new BridgeError('UNAUTHORIZED', 'A valid local connection token is required.', 401);
    if (counts.origin || Object.hasOwn(request.headers, 'origin'))
      throw new BridgeError('ORIGIN_REJECTED', 'Browser-origin requests are not accepted.', 403);
    if (counts.host !== 1 || request.headers.host !== '127.0.0.1:' + this.#port)
      throw new BridgeError(
        'HOST_REJECTED',
        'Request Host must match the loopback connection.',
        403,
      );
    this.#assertOpen();
  }

  #respond(response, status, body) {
    if (response.destroyed || response.writableEnded) return;
    const text = JSON.stringify(body);
    response.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Length': Buffer.byteLength(text),
      Connection: 'close',
    });
    response.end(text);
  }

  async #handle(request, response) {
    try {
      this.#authenticate(request);
      if (request.method === 'GET' && request.url === '/info') {
        this.#respond(response, 200, { result: this.info() });
        return;
      }
      if (request.method === 'GET' && request.url === '/tools') {
        this.#respond(response, 200, { result: AGENT_TOOLS });
        return;
      }
      if (request.method !== 'POST' || request.url !== '/call')
        throw new BridgeError('NOT_FOUND', 'Unknown bridge route.', 404);
      if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] ?? ''))
        throw new BridgeError('CONTENT_TYPE', 'Use application/json for tool calls.', 415);
      if (Number(request.headers['content-length']) > BODY_LIMIT)
        throw new BridgeError('BODY_TOO_LARGE', 'Request body exceeds 128 KiB.', 413);
      const body = await readBody(request);
      if (
        !body ||
        typeof body !== 'object' ||
        Array.isArray(body) ||
        Object.keys(body).some((key) => !['method', 'args'].includes(key))
      )
        throw new BridgeError('INVALID_REQUEST', 'Expected a method and arguments object.');
      let args;
      try {
        args = validateCall(body.method, body.args === undefined ? {} : body.args);
      } catch (error) {
        throw new BridgeError('INVALID_ARGUMENTS', error.message);
      }
      this.#lastClient = String(request.headers['x-mosaic-client'] ?? 'Local agent')
        .split(this.#token)
        .join('[redacted]')
        .replace(/[\x00-\x1f\x7f]/g, '')
        .slice(0, 120);
      const operation = this.#enqueue(body.method, args);
      const disconnected = () => {
        if (!response.writableEnded) operation.cancel();
      };
      response.once('close', disconnected);
      if (response.destroyed) operation.cancel();
      try {
        this.#respond(response, 200, { result: await operation.promise });
      } finally {
        response.off('close', disconnected);
      }
    } catch (error) {
      this.#respond(response, error instanceof BridgeError ? error.status : 500, {
        error: this.#publicError(error),
      });
      request.resume();
    }
  }
}
