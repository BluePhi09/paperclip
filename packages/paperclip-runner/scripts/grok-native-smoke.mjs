import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdir, mkdtemp, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { AcpxRuntimeHost } from '../dist/drivers/acpx/runtime-host.js';
import { openQualifiedAcpxRuntime } from '../dist/drivers/acpx/codex-runtime-adapter.js';
import { QUALIFIED_ACPX_PROFILES } from '../dist/drivers/acpx/qualified-profiles.js';

const { values } = parseArgs({ options: { auth: { type: 'string', default: 'subscription' }, 'auth-file': { type: 'string' }, output: { type: 'string' }, repetitions: { type: 'string', default: '3' } } });
assert(values.output, 'An output path is required to retain every attempt');
assert(['subscription', 'api'].includes(values.auth));
const repetitions = Number(values.repetitions);
assert(Number.isSafeInteger(repetitions) && repetitions > 0 && repetitions <= 3);
const environment = { PATH: process.env.PATH };
if (values.auth === 'api') {
  assert(process.env.XAI_API_KEY, 'Explicit XAI_API_KEY is required');
  environment.XAI_API_KEY = process.env.XAI_API_KEY;
} else {
  assert(values['auth-file'], 'An explicit subscription auth-file is required');
  environment.PAPERCLIP_ACPX_GROK_AUTH_JSON_SECRET = await readFile(values['auth-file'], 'utf8');
}
const report = { schema: 'paperclip.grok-native-smoke.v1', auth: values.auth, sourceRevision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), sourceDirty: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).length > 0, profile: QUALIFIED_ACPX_PROFILES.grok, platform: `${process.platform}-${process.arch}`, startedAt: new Date().toISOString(), attempts: [] };
const binary = await readFile(new URL('../../grok-acp/bin/grok', import.meta.url));
report.binaryDigest = `sha256:${createHash('sha256').update(binary).digest('hex')}`;
async function persist() { await writeFile(resolve(values.output), JSON.stringify(report, null, 2)+'\n', { mode: 0o600 }); }
await persist();
for (let repetition=1; repetition<=repetitions; repetition++) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'paperclip-grok-smoke-')));
  await mkdir(join(root,'runtime'), { mode:0o700 }); await mkdir(join(root,'workspace'), { mode:0o700 });
  const nonce=randomUUID(); let calls=0; let host;
  const attempt = { repetition, startedAt: new Date().toISOString(), status: 'running', checks: {}, usage: null, cost: null };
  report.attempts.push(attempt); await persist();
  const start = Date.now();
  const options = { runtimeDirectory:join(root,'runtime'), normalizedSessionId:'grok-smoke', workingDirectory:join(root,'workspace'), agent:'grok', model:'grok-4.7', permissionMode:'approve-all', environment, systemInstructions:'Use the requested MCP tool and retain its nonce in this session. Do not use other tools. Answer briefly.', semanticTools: { tools:[{ name:'check_context', description:'Read this task’s qualification nonce.', inputSchema:{type:'object', properties:{}, additionalProperties:false} }], handler:async call=>{assert.equal(call.tool,'check_context'); calls++; return {nonce};} } };
  const dependencies={openRuntime:openQualifiedAcpxRuntime, reportRetainedCleanupFailure:()=>{ attempt.checks.cleanup=false; }};
  async function turn(text,id) {
    const handle=host.startTurn({text, requestId:id, signal:AbortSignal.timeout(120000)}); let output=''; const counts={};
    const drain=(async()=>{for await(const event of handle.events){counts[event.type]=(counts[event.type]??0)+1;if(event.type==='text_delta' && event.stream!=='thought')output+=event.text;}})();
    const result=await handle.result;await drain;attempt.lastTurnStatus=result.status;attempt.stopReason=result.stopReason;attempt.failureCode=result.error?.code??null;attempt.failureCategory=result.error?.category??null; attempt.lastEventCounts=counts;attempt.outputLength=output.length;if(result.status!=='completed') throw Object.assign(new Error('Provider turn did not complete'),{code:result.error?.code ?? result.status});return {output,counts};
  }
  try {
    host=await AcpxRuntimeHost.open({...options,signal:AbortSignal.timeout(45000)},dependencies);
    const identity=host.identity(); assert.equal(identity.effectiveModel,'grok-4.7');attempt.checks.model=true;
    const first=await turn('Call check_context exactly once, then reply with only the returned nonce.',`tool-${repetition}`);
    attempt.toolCalls=calls;attempt.nonceObserved=first.output.includes(nonce);assert.equal(calls,1);assert(first.output.includes(nonce));attempt.checks.authenticatedTool=true;attempt.events=first.counts;
    await host.close({reason:'verify persisted resume'});host=null;
    host=await AcpxRuntimeHost.open({...options,expectedIdentity:identity,signal:AbortSignal.timeout(45000)},dependencies);
    assert.equal(host.identity().agentSessionId,identity.agentSessionId);
    const second=await turn('Without using tools, reply with only the nonce returned in the previous turn.',`resume-${repetition}`);
    assert(second.output.includes(nonce));assert.equal(calls,1);attempt.checks.resumeIdentity=true;
    await host.close({reason:'verify restrictive permissions'});host=null;
    const restricted={...options,normalizedSessionId:'grok-restricted',permissionMode:'approve-reads'};
    host=await AcpxRuntimeHost.open({...restricted,signal:AbortSignal.timeout(45000)},dependencies);
    let restrictedResult;
    try { await turn('Use the shell to create a file named restricted-proof.txt in the working directory, then stop.',`permission-${repetition}`); }
    catch(error) { restrictedResult=error.code ?? error.name; }
    // Restricted Grok writes must route through the existing approval-required outcome.
    assert.equal(restrictedResult,'approval_required');
    await assert.rejects(readFile(join(root,'workspace','restricted-proof.txt')),{code:'ENOENT'});
    attempt.checks.permissionBoundary=true;
    attempt.status='passed';
  } catch(error) { attempt.status='failed'; attempt.errorCode=error.code??error.name; /* Raw errors and provider text stay out of this sanitized proof. */ }
  finally { if(host) {try{await host.close({reason:'qualification cleanup'});}catch{attempt.status='failed';attempt.checks.cleanup=false;}} await rm(root,{recursive:true,force:true}); attempt.elapsedMs=Date.now()-start;await persist(); }
  console.log(`Grok ${values.auth} repetition ${repetition}: ${attempt.status}`);
}
report.finishedAt=new Date().toISOString(); await persist();
process.exitCode=report.attempts.every(attempt=>attempt.status==='passed')?0:1;
