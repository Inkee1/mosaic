import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ProviderRegistry } from '../ai/providers.mjs';
import { ProviderProcess, resolveProviderCommand } from '../ai/provider-process.mjs';

// The subprocess fixture is a protocol peer. Production framing, requests,
// process ownership, cancellation and event translation run unchanged.
const fixture = String.raw`
import { appendFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
const [provider, log, scenario, ...args] = process.argv.slice(2);
const record = value => appendFileSync(log, JSON.stringify({ provider, pid:process.pid, ...value }) + '\n');
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
record({ spawn: args, pid: process.pid });
if (args.includes('--version')) { if(scenario==='slow-discovery'){setInterval(()=>{},1000);}else{console.log(provider === 'claude' ? '2.1.319 (Claude Code)' : 'codex-cli 0.167.0'); process.exit(0);} }
if (args.includes('auth')) { console.log(JSON.stringify({loggedIn: scenario !== 'logged-out', email:'private@example.test'})); process.exit(scenario === 'logged-out' ? 1 : 0); }
let added = false;
let appliedModel=scenario==='resume-defaults'?'claude-saved':'claude-test',appliedEffort='high';
const cliConfig = Object.fromEntries(args.flatMap((arg, i) => arg === '-c' ? [args[i+1].split(/=(.*)/s).slice(0,2)] : []));
const peer = createInterface({ input:process.stdin });
peer.on('line', line => {
 const m = JSON.parse(line); record({ input: m });
 if (provider === 'claude') {
  if (m.type === 'control_request') {
   const subtype=m.request.subtype;let response={};
   if(scenario==='slow-initialize'&&subtype==='initialize')return;
   if(subtype==='initialize')response={models:[{value:'default',resolvedModel:'claude-test',displayName:'Default',supportedEffortLevels:['low','high']},{value:'sonnet',resolvedModel:'claude-test',displayName:'Sonnet',supportsEffort:true,supportedEffortLevels:['low','high']}],account:{email:'private@example.test',accessToken:'never-display-this'},claude_code_version:'2.1.319'};
   if(subtype==='mcp_set_servers'){added=true;response={added:['mosaic'],removed:[],errors:{}};}
   if(subtype==='mcp_status')response={mcpServers:added?[{name:scenario==='foreign-mcp'?'outside':'mosaic',status:'connected',tools:[{name:'list_panes'},{name:'snapshot'}]}]:[]};
   if(subtype==='get_settings')response={applied:{model:appliedModel,effort:appliedEffort}};
   if(subtype==='apply_flag_settings'){if(m.request.settings.model===null)appliedModel='claude-default';if(m.request.settings.effortLevel===null)appliedEffort='low';}
   if(subtype==='interrupt'){if(scenario==='stubborn')return;setTimeout(()=>{record({exited:true});process.exit(0);},100);return;}
   send({type:'control_response',response:{subtype:'success',request_id:m.request_id,response}});
  }
  if(m.type==='user'){
   if(scenario==='hanging')return;
   if(scenario==='stubborn'){const descendant=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});record({descendant:descendant.pid});setInterval(()=>{},1000);return;}
   send({type:'system',subtype:'init',session_id:'claude-session',model:appliedModel,tools:['mcp__mosaic__list_panes'],mcp_servers:[{name:'mosaic',status:'connected'}]});
   send({type:'stream_event',event:{type:'content_block_delta',delta:{type:'thinking_delta',thinking:'HIDDEN_REASONING'}}});
   send({type:'stream_event',event:{type:'content_block_delta',delta:{type:'text_delta',text:'안녕 '}}});
   send({type:'assistant',message:{id:'msg1',model:appliedModel,content:[{type:'text',text:'안녕 '}]}});
   send({type:'assistant',message:{id:'msg2',model:appliedModel,content:[{type:'text',text:'world'}]}});
   send({type:'stream_event',event:{type:'content_block_start',content_block:{type:'tool_use',id:'browser-call-1',name:'mcp__mosaic__snapshot'}}});
   send({type:'assistant',message:{id:'msg3',content:[{type:'tool_use',id:'browser-call-1',name:'mcp__mosaic__snapshot'}]}});
   send({type:'control_request',request_id:'untrusted-tool',request:{subtype:'can_use_tool',tool_name:'Bash',input:{command:'DO_NOT_RUN'}}});
   send({type:'result',subtype:scenario==='provider-error'?'error_during_execution':'success',is_error:scenario==='provider-error',errors:['Account limit reached'],session_id:'claude-session',result:'안녕 world',usage:{input_tokens:10,output_tokens:2}});
  }
 } else {
  if(!m.id)return;
  let result={};
  if(m.method==='initialize')result={userAgent:'codex-cli/0.167.0'};
  if(m.method==='account/read')result={account:scenario==='logged-out'?null:{type:'chatgpt',email:'private@example.test',accessToken:'never-display-this'},requiresOpenaiAuth:true};
  if(m.method==='model/list')result={data:[{id:'model-live',model:'model-live',displayName:'Live model',supportedReasoningEfforts:[{reasoningEffort:'low'},{reasoningEffort:'high'}],defaultReasoningEffort:'low',isDefault:true}],nextCursor:null};
  if(m.method==='config/read')result={config:{model:'model-live',model_reasoning_effort:['configured-default','resume-defaults'].includes(scenario)?'high':'low',mcp_servers:{outside:{command:'must-not-start',enabled:cliConfig['mcp_servers.outside.enabled']!=='false'}},features:Object.fromEntries(Object.entries(cliConfig).filter(([key])=>key.startsWith('features.')).map(([key,v])=>[key.slice(9),v==='true'])),plugins:{foreign:{enabled:cliConfig['plugins.foreign.enabled']!=='false'}},apps:{_default:{enabled:false}}}};
  if(m.method==='thread/start'||m.method==='thread/resume')result={thread:{id:m.params.threadId||'codex-session'},model:m.params.model||(scenario==='resume-defaults'?'model-saved':'model-live'),reasoningEffort:m.params.config?.model_reasoning_effort||(scenario==='resume-defaults'?'saved-effort':'low')};
  if(m.method==='mcpServerStatus/list')result={data:[{name:scenario==='foreign-mcp'?'outside':'mosaic',runtimeStatus:'ready',tools:{list_panes:{name:'list_panes'}}}],nextCursor:null};
  if(m.method==='turn/interrupt'){setTimeout(()=>{record({exited:true});process.exit(0);},100);return;}
  if(m.method==='turn/start'){
   if(scenario==='mcp-policy'&&cliConfig['mcp_servers.mosaic.tools.type.approval_mode']!=='"approve"'){send({id:m.id,error:{message:'MCP tool call requires approval, but approval policy is never'}});return;}
   send({id:m.id,result:{turn:{id:'turn-1',status:'inProgress'}}});
   if(scenario==='hanging')return;
   send({method:'item/reasoning/textDelta',params:{delta:'HIDDEN_REASONING'}});
   send({method:'item/agentMessage/delta',params:{threadId:'codex-session',turnId:'turn-1',itemId:'message1',delta:'안녕 '}});
   send({method:'item/agentMessage/delta',params:{threadId:'codex-session',turnId:'turn-1',itemId:'message1',delta:'world'}});
   send({method:'item/completed',params:{threadId:'codex-session',turnId:'turn-1',item:{id:'message1',type:'agentMessage',text:'안녕 world'}}});
   send({id:900,method:'item/commandExecution/requestApproval',params:{threadId:'codex-session',command:'DO_NOT_RUN'}});
   send({method:'thread/tokenUsage/updated',params:{threadId:'codex-session',tokenUsage:{last:{inputTokens:10,outputTokens:2}}}});
   send({method:'turn/completed',params:{threadId:'codex-session',turn:{id:'turn-1',status:scenario==='provider-error'?'failed':'completed',error:scenario==='provider-error'?{message:'Account limit reached'}:null}}});return;
  }
  send({id:m.id,result});
 }
});
peer.on('close',()=>{if(scenario==='stubborn')return;record({exited:true});process.exit(0);});
`;

async function setup(t, scenario = 'normal') {
  const directory = await mkdtemp(join(tmpdir(), 'mosaic-providers-'));
  const peer = join(directory, 'peer.mjs'),
    log = join(directory, 'protocol.jsonl');
  await writeFile(peer, fixture);
  await writeFile(log, '');
  const registry = new ProviderRegistry({
    directory,
    root: resolve('.'),
    resolveCommand: async (provider) => ({
      command: process.execPath,
      args: [peer, provider, log, scenario],
    }),
    timeouts: { request: 3000, shutdown: 500 },
  });
  t.after(async () => {
    await registry.close();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    registry,
    directory,
    log,
    records: async () =>
      (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse),
  };
}
const input = (directory) => ({
  model: '',
  effort: 'default',
  prompt: 'Hello $() ` literal\n새 질문',
  cwd: directory,
  connectionFile: join(directory, 'unique-run-connection.json'),
});

test('discovery uses live catalogs without inference or leaking account fields', async (t) => {
  const { registry, records } = await setup(t);
  const infos = await registry.discover();
  assert.deepEqual(
    infos.map((i) => i.status),
    ['ready', 'ready'],
  );
  assert.deepEqual(
    infos.find((i) => i.id === 'claude').models.find((m) => m.id === 'sonnet').efforts,
    ['low', 'high'],
  );
  assert.equal(
    infos.find((i) => i.id === 'codex').models.find((m) => m.id === 'model-live').defaultEffort,
    'low',
  );
  assert.doesNotMatch(JSON.stringify(infos), /private@|never-display/);
  assert.equal(
    (await records()).some(
      (r) =>
        r.input?.method === 'turn/start' ||
        r.input?.type === 'user' ||
        r.input?.method === 'thread/start',
    ),
    false,
  );
});

for (const provider of ['claude', 'codex']) {
  test(
    provider + ' streams only visible text, resumes its own session and records effective settings',
    async (t) => {
      const { registry, directory, records } = await setup(t);
      const events = [];
      const result = await registry.run({
        ...input(directory),
        provider,
        model: provider === 'claude' ? 'sonnet' : 'model-live',
        effort: 'high',
        sessionId: provider + '-session',
        onEvent: (e) => events.push(e),
      });
      assert.equal(result.sessionId, provider + '-session');
      assert.equal(result.text, '안녕 world');
      assert.equal(
        events
          .filter((e) => e.type === 'text')
          .map((e) => e.text)
          .join(''),
        '안녕 world',
      );
      assert.doesNotMatch(JSON.stringify(events), /HIDDEN_REASONING|never-display|DO_NOT_RUN/);
      assert.ok(
        events.some((e) => e.type === 'usage' && e.inputTokens === 10 && e.outputTokens === 2),
      );
      const rs = await records();
      if (provider === 'codex') {
        const resume = rs.find((r) => r.input?.method === 'thread/resume').input.params;
        assert.equal(resume.threadId, 'codex-session');
        assert.equal(resume.model, 'model-live');
        const turn = rs.find((r) => r.input?.method === 'turn/start').input.params;
        assert.equal(turn.effort, 'high');
        assert.deepEqual(turn.environments, []);
        assert.equal(turn.input[0].text, input(directory).prompt);
        assert.deepEqual(turn.input[0].text_elements, []);
        assert.ok(rs.some((r) => r.spawn?.includes('mcp_servers.outside.enabled=false')));
        assert.ok(rs.some((r) => r.input?.id === 900 && r.input.result?.decision === 'decline'));
      } else {
        assert.ok(rs.some((r) => r.spawn?.includes('--safe-mode')));
        assert.ok(
          rs.some((r) => r.spawn?.includes('--resume') && r.spawn.includes('claude-session')),
        );
        const mcp = rs.find((r) => r.input?.request?.subtype === 'mcp_set_servers').input.request
          .servers;
        assert.deepEqual(Object.keys(mcp), ['mosaic']);
        assert.equal(mcp.mosaic.args.at(-1), input(directory).connectionFile);
        assert.ok(
          rs.some(
            (r) =>
              r.input?.response?.request_id === 'untrusted-tool' &&
              r.input.response.response?.behavior === 'deny',
          ),
        );
      }
      assert.ok(
        rs
          .filter((r) => r.spawn)
          .every(
            (r) =>
              rs.some((x) => x.pid === r.pid && x.exited) ||
              r.spawn.includes('--version') ||
              r.spawn.includes('auth'),
          ),
      );
    },
  );
  test(provider + ' omits default model and effort overrides', async (t) => {
    const { registry, directory, records } = await setup(t);
    await registry.run({ ...input(directory), provider });
    const rs = await records();
    if (provider === 'codex') {
      const p = rs.find((r) => r.input?.method === 'turn/start').input.params;
      assert.equal('model' in p, false);
      assert.equal('effort' in p, false);
    } else {
      assert.ok(
        rs
          .filter((r) => r.spawn?.includes('-p'))
          .every((r) => !r.spawn.includes('--effort') && !r.spawn.includes('--model')),
      );
    }
  });
  test(provider + ' fails closed before inference if unrelated MCP tools appear', async (t) => {
    const { registry, directory, records } = await setup(t, 'foreign-mcp');
    await assert.rejects(registry.run({ ...input(directory), provider }), /MCP|scoped|isolation/i);
    assert.equal(
      (await records()).some((r) => r.input?.method === 'turn/start' || r.input?.type === 'user'),
      false,
    );
  });
  test(provider + ' cancellation waits for its process to exit', async (t) => {
    const { registry, directory, records } = await setup(t, 'hanging');
    const controller = new AbortController();
    const run = registry.run({ ...input(directory), provider, signal: controller.signal });
    while (
      !(await records()).some((r) => r.input?.type === 'user' || r.input?.method === 'turn/start')
    )
      await new Promise((r) => setTimeout(r, 10));
    controller.abort();
    await assert.rejects(run, { name: 'AbortError' });
    const rs = await records();
    const started = rs
      .filter((r) => r.spawn?.includes(provider === 'claude' ? '-p' : 'app-server'))
      .at(-1);
    assert.ok(rs.some((r) => r.exited && r.pid === started.pid));
  });
  test(
    provider + ' reports provider failure without presenting partial output as success',
    async (t) => {
      const { registry, directory } = await setup(t, 'provider-error');
      await assert.rejects(
        registry.run({ ...input(directory), provider }),
        /Account limit reached/,
      );
    },
  );
}

test('unauthenticated providers are login-required and login gives official actionable guidance', async (t) => {
  const { registry } = await setup(t, 'logged-out');
  assert.deepEqual(
    (await registry.discover()).map((p) => p.status),
    ['login-required', 'login-required'],
  );
  assert.match((await registry.login('claude')).message, /claude auth login/);
  assert.match((await registry.login('codex')).message, /codex login/);
});

test('invalid provider and unsupported effort cannot reach inference', async (t) => {
  const { registry, directory, records } = await setup(t);
  await assert.rejects(registry.run({ ...input(directory), provider: 'untrusted' }), /provider/i);
  await registry.discover();
  await assert.rejects(
    registry.run({
      ...input(directory),
      provider: 'codex',
      model: 'model-live',
      effort: 'impossible',
    }),
    /effort/i,
  );
  assert.equal(
    (await records()).some((r) => r.input?.method === 'turn/start'),
    false,
  );
});

test('Codex default effort reflects configured CLI settings rather than catalog recommendations', async (t) => {
  const { registry } = await setup(t, 'configured-default');
  const info = (await registry.discover()).find((p) => p.id === 'codex');
  assert.equal(info.models.find((m) => m.id === '').defaultEffort, 'high');
});

test('stop terminates an unresponsive provider and its child before rejecting', async (t) => {
  const { registry, directory, records } = await setup(t, 'stubborn');
  const controller = new AbortController();
  const run = registry.run({ ...input(directory), provider: 'claude', signal: controller.signal });
  let child;
  while (!(child = (await records()).find((r) => r.descendant)))
    await new Promise((r) => setTimeout(r, 10));
  controller.abort();
  await assert.rejects(run, { name: 'AbortError' });
  assert.throws(() => process.kill(child.pid, 0));
  assert.throws(() => process.kill(child.descendant, 0));
});

test(
  'Windows npm shim resolution selects the official native binary without a command shell',
  { skip: process.platform !== 'win32' },
  async (t) => {
    const { mkdir } = await import('node:fs/promises');
    const directory = await mkdtemp(join(tmpdir(), 'mosaic-resolution-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const npm = join(directory, 'npm'),
      native = join(
        npm,
        'node_modules/@openai/codex/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe',
      );
    await mkdir(join(npm, 'node_modules/@openai/codex/bin'), { recursive: true });
    await mkdir(resolve(native, '..'), { recursive: true });
    await writeFile(native, 'fixture');
    await writeFile(join(npm, 'node_modules/@openai/codex/bin/codex.js'), 'fixture');
    await writeFile(join(npm, 'codex.cmd'), '@echo shim');
    const resolved = await resolveProviderCommand('codex', { PATH: npm, APPDATA: directory });
    assert.equal(resolved.command, native);
    assert.deepEqual(resolved.args, []);
  },
);

test('registry close cancels discovery and waits for its version process to exit', async (t) => {
  const { registry, records } = await setup(t, 'slow-discovery');
  const discovery = registry.discover();
  let started;
  while (!(started = (await records()).find((r) => r.spawn?.includes('--version'))))
    await new Promise((r) => setTimeout(r, 10));
  await registry.close();
  let alive = true;
  try {
    process.kill(started.pid, 0);
  } catch {
    alive = false;
  }
  if (alive) {
    for (const row of (await records()).filter((r) => r.spawn))
      try {
        process.kill(row.pid);
      } catch {}
  }
  await discovery;
  assert.equal(alive, false, 'close returned while a discovery process was alive');
});

test('protocol framing preserves UTF-8 split across writes and rejects malformed output', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'mosaic-framing-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const peer = join(directory, 'fragmented.mjs');
  await writeFile(
    peer,
    String.raw`const b=Buffer.from(JSON.stringify({type:'sample',text:'한글'})+'\n');const at=b.indexOf(Buffer.from('한'))+1;process.stdout.write(b.subarray(0,at));setTimeout(()=>process.stdout.write(b.subarray(at)),10);setTimeout(()=>process.stdout.write('invalid-json\n'),30);process.stdin.resume();`,
  );
  const client = new ProviderProcess(process.execPath, [peer], {
    cwd: directory,
    env: process.env,
    shutdownTimeout: 100,
  });
  t.after(() => client.stop());
  const events = [];
  const failure = new Promise((resolve) =>
    client.subscribe((event) => {
      events.push(event);
      if (event.type === 'mosaic_process_error') resolve(event.error);
    }),
  );
  const error = await failure;
  assert.equal(events[0].text, '한글');
  assert.match(error.message, /invalid JSON/);
  await client.stop();
  assert.equal(client.closed, true);
});

test('Claude logs one action for the same tool-use ID in streamed and complete messages', async (t) => {
  const { registry, directory } = await setup(t);
  const events = [];
  await registry.run({
    ...input(directory),
    provider: 'claude',
    onEvent: (event) => events.push(event),
  });
  assert.equal(
    events.filter((e) => e.type === 'tool' && e.name === 'mcp__mosaic__snapshot').length,
    1,
  );
});

test('Codex explicitly approves only granted Mosaic tool names while keeping unrelated execution disabled', async (t) => {
  const { registry, directory, records } = await setup(t, 'mcp-policy');
  await registry.run({ ...input(directory), provider: 'codex' });
  const args = (await records()).find((r) =>
    r.spawn?.includes('mcp_servers.mosaic.enabled=true'),
  ).spawn;
  assert.ok(args.includes('mcp_servers.mosaic.tools.type.approval_mode="approve"'));
  assert.ok(args.includes('mcp_servers.outside.enabled=false'));
  assert.ok(args.includes('features.shell_tool=false'));
  assert.ok(!args.includes('mcp_servers.outside.tools.type.approval_mode="approve"'));
});

test('Claude resume resets default selections and reports provider-confirmed effective settings', async (t) => {
  const { registry, directory, records } = await setup(t, 'resume-defaults');
  const events = [];
  const result = await registry.run({
    ...input(directory),
    provider: 'claude',
    sessionId: 'claude-session',
    onEvent: (event) => events.push(event),
  });
  assert.equal(result.model, 'claude-default');
  assert.equal(result.effort, 'low');
  assert.ok(events.some((e) => e.type === 'settings' && e.effort === 'low'));
  const resets = (await records()).find((r) => r.input?.request?.subtype === 'apply_flag_settings')
    .input.request.settings;
  assert.deepEqual(resets, { model: null, effortLevel: null });
});

test('Codex resume resets default selections to current CLI defaults instead of saved overrides', async (t) => {
  const { registry, directory } = await setup(t, 'resume-defaults');
  const result = await registry.run({
    ...input(directory),
    provider: 'codex',
    sessionId: 'codex-session',
  });
  assert.equal(result.model, 'model-live');
  assert.equal(result.effort, 'high');
});

test('stopping during catalog initialization interrupts discovery without waiting for its request timeout', async (t) => {
  const { registry, directory, records } = await setup(t, 'slow-initialize');
  const controller = new AbortController();
  const run = registry.run({ ...input(directory), provider: 'claude', signal: controller.signal });
  while (!(await records()).some((r) => r.input?.request?.subtype === 'initialize'))
    await new Promise((r) => setTimeout(r, 10));
  const stoppedAt = Date.now();
  controller.abort();
  await assert.rejects(run, { name: 'AbortError' });
  assert.ok(Date.now() - stoppedAt < 1000, 'abort waited for discovery request timeout');
});
