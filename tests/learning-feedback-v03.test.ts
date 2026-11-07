import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { CanvasService } from '../server/service.js';
import { Store } from '../server/store.js';
import { createApp } from '../server/app.js';
import type { Run } from '../src/shared/types.js';

const policy = { remoteEnabled: false, providerOrigins: ['https://api.openai.com'], mediaOrigins: [] };
function fixture() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'relay-local-feedback-'));
  const store = new Store(dir);
  const service = new CanvasService(store, policy);
  return { dir, store, service, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
function seed(store: Store, secondKind: 'image' | 'video' = 'image', secondUrl = 'https://media.example.com/b.png') {
  const data = store.read(), board = data.boards.find(item => item.id === 'welcome')!;
  const a: Run = { id: 'runA', boardId: board.id, revision: board.revision, operationId: 'opA',
    status: 'succeeded', startedAt: '2026-11-01T00:00:00.000Z', finishedAt: '2026-11-01T00:01:00.000Z',
    snapshot: board, providers: data.providers, order: ['frame'], results: {
      frame: { nodeId: 'frame', status: 'succeeded', artifacts: [{ kind: 'image', url: 'https://media.example.com/a.png' }] }
    } };
  const b: Run = { id: 'runB', boardId: board.id, revision: board.revision, operationId: 'opB',
    status: 'succeeded', startedAt: '2026-11-01T00:02:00.000Z', finishedAt: '2026-11-01T00:03:00.000Z',
    snapshot: board, providers: data.providers, order: ['frame'], results: {
      frame: { nodeId: 'frame', status: 'succeeded', artifacts: [{ kind: secondKind, url: secondUrl }] }
    } };
  store.transaction(data => { data.runs.push(a, b); });
}
function feedback(op = 'choose-01') {
  return { operationId: op, boardId: 'welcome', nodeId: 'frame',
    leftRunId: 'runA', rightRunId: 'runB',
    leftArtifactIndex: 0, rightArtifactIndex: 0,
    choice: 'left' as const, reason: 'identity' as const, consentRevision: 1 };
}
test('local feedback is off by default, consent is a durable opt-in, and records survive restart', () => {
  const f=fixture();
  try {
    seed(f.store);
    assert.deepEqual(f.service.learningFeedbackStatus(), { enabled:false, revision:0, recordCount:0, scope:'local_only', attribution:'unverified' });
    assert.throws(()=>f.service.recordLocalFeedback(feedback()), (err: unknown)=>(err as { code?:string }).code==='FEEDBACK_DISABLED');
    assert.deepEqual(f.service.setLearningFeedbackConsent({enabled:true,expectedRevision:0}),
      { enabled:true, revision:1, recordCount:0, scope:'local_only', attribution:'unverified' });
    const first=f.service.recordLocalFeedback(feedback());
    assert.equal(first.choice,'left'); assert.equal(first.source,'local_ui_unverified');
    assert.deepEqual(first.reason,'identity');
    assert.equal(f.service.recordLocalFeedback(feedback()).id,first.id);
    assert.equal(new CanvasService(new Store(f.dir),policy).learningFeedbackStatus().recordCount,1);
    const data=new Store(f.dir).read();
    assert.equal(data.learningFeedback?.length,1);
    assert.equal(data.learningOutbox?.length??0,0);
    assert.equal(Object.hasOwn(f.service.state(),'learningFeedback'),false);
    assert.equal(Object.hasOwn(f.service.state(),'learningFeedbackConsent'),false);
    const serialized=JSON.stringify(data.learningFeedback);
    assert.equal(serialized.includes('media.example.com'),false);
    assert.equal(serialized.includes('prompt'),false);
    assert.equal(serialized.includes('keyEnv'),false);
  } finally { f.cleanup(); }
});
test('revocation erases stored feedback in the same transaction and blocks future records', () => {
  const f=fixture();
  try {
    seed(f.store); f.service.setLearningFeedbackConsent({enabled:true,expectedRevision:0});
    f.service.recordLocalFeedback(feedback());
    assert.equal(f.service.setLearningFeedbackConsent({enabled:false,expectedRevision:1}).recordCount,0);
    const recovered=new CanvasService(new Store(f.dir),policy);
    assert.equal(recovered.learningFeedbackStatus().enabled,false);
    assert.deepEqual(new Store(f.dir).read().learningFeedback,[]);
    assert.throws(()=>recovered.recordLocalFeedback({...feedback(),consentRevision:2}));
    assert.equal(recovered.setLearningFeedbackConsent({enabled:false,expectedRevision:1}).revision,2);
    recovered.setLearningFeedbackConsent({enabled:true,expectedRevision:2});
    assert.equal(recovered.learningFeedbackStatus().recordCount,0);
  } finally { f.cleanup(); }
});
test('duplicate canonical pair, reversed order, and reused operation IDs do not poison labels', () => {
  const f=fixture();
  try {
    seed(f.store);f.service.setLearningFeedbackConsent({enabled:true,expectedRevision:0});
    f.service.recordLocalFeedback(feedback());
    assert.throws(()=>f.service.recordLocalFeedback({...feedback('choose-02'),choice:'right'}),
      (err: unknown)=>(err as {code?:string}).code==='FEEDBACK_ALREADY_RECORDED');
    assert.throws(()=>f.service.recordLocalFeedback({
      ...feedback('choose-03'),leftRunId:'runB',rightRunId:'runA',choice:'right'
    }), (err: unknown)=>(err as {code?:string}).code==='FEEDBACK_ALREADY_RECORDED');
    assert.throws(()=>f.service.recordLocalFeedback({...feedback(),reason:'motion'}),
      (err: unknown)=>(err as {code?:string}).code==='FEEDBACK_OPERATION_CONFLICT');
    assert.equal(f.service.learningFeedbackStatus().recordCount,1);
  } finally { f.cleanup(); }
});
test('stale consent revisions, unknown run and malformed payload fail closed', () => {
  const f=fixture();
  try {
    seed(f.store);f.service.setLearningFeedbackConsent({enabled:true,expectedRevision:0});
    assert.throws(()=>f.service.setLearningFeedbackConsent({enabled:false,expectedRevision:5}),
      (err: unknown)=>(err as {code?:string}).code==='CONSENT_REVISION_CONFLICT');
    assert.throws(()=>f.service.recordLocalFeedback({...feedback(),consentRevision:0}),
      (err: unknown)=>(err as {code?:string}).code==='CONSENT_REVISION_CONFLICT');
    assert.throws(()=>f.service.recordLocalFeedback({...feedback(),rightRunId:'missing'}),
      (err: unknown)=>(err as {code?:string}).code==='RUN_BOARD_MISMATCH');
    assert.throws(()=>f.service.recordLocalFeedback({...feedback(),privatePrompt:'never accepted'}));
    assert.throws(()=>f.service.recordLocalFeedback({...feedback(),reason:'arbitrary raw text'}));
    assert.throws(()=>f.service.setLearningFeedbackConsent({enabled:true,expectedRevision:1,globalLearningAllowed:true}));
    assert.equal(f.service.learningFeedbackStatus().recordCount,0);
  } finally { f.cleanup(); }
});
test('feedback refuses identical outputs, incompatible media types and unfinished runs', () => {
  for(const [kind,url] of [
    ['image','https://media.example.com/a.png'],
    ['video','https://media.example.com/b.mp4']
  ] as const) {
    const f=fixture();
    try {
      seed(f.store,kind,url);f.service.setLearningFeedbackConsent({enabled:true,expectedRevision:0});
      assert.throws(()=>f.service.recordLocalFeedback(feedback()),
        (err: unknown)=>(err as {code?:string}).code==='FEEDBACK_NOT_ELIGIBLE');
    } finally {f.cleanup();}
  }
  const f=fixture();
  try {
    seed(f.store);f.service.setLearningFeedbackConsent({enabled:true,expectedRevision:0});
    f.store.transaction(data=>{data.runs.find(x=>x.id==='runB')!.status='running';});
    assert.throws(()=>f.service.recordLocalFeedback(feedback()),
      (err: unknown)=>(err as {code?:string}).code==='FEEDBACK_NOT_ELIGIBLE');
    assert.equal(f.service.learningFeedbackStatus().recordCount,0);
  } finally {f.cleanup();}
});
test('feedback maximum prevents unbounded workspace growth', () => {
  const f=fixture();
  try {
    seed(f.store);f.service.setLearningFeedbackConsent({enabled:true,expectedRevision:0});
    const base=f.service.recordLocalFeedback(feedback());
    f.store.transaction(data=>{
      data.learningFeedback=Array.from({length:200},(_,i)=>({
        ...base,id:randomUUID(),operationId:'fake-'+i,
        leftRunId:'lhs-'+i,rightRunId:'rhs-'+i
      }));
    });
    assert.throws(()=>f.service.recordLocalFeedback({...feedback('fresh'),choice:'right'}),
      (err: unknown)=>(err as {code?:string}).code==='FEEDBACK_LIMIT');
    assert.equal(f.service.learningFeedbackStatus().recordCount,200);
  } finally {f.cleanup();}
});
test('HTTP feedback endpoints require local token, declared UI channel and explicit consent', async () => {
  const f=fixture();
  const {app,token}=createApp(f.service,'http://127.0.0.1:43189');
  const server=http.createServer(app);
  try {
    seed(f.store);
    await new Promise<void>(resolve=>server.listen(43189,'127.0.0.1',resolve));
    const origin='http://127.0.0.1:43189';
    const auth={Origin:origin,'X-Canvas-Token':token,'X-Canvas-Client':'ui','Content-Type':'application/json'};
    const consent='/api/learning/feedback/consent', record='/api/learning/feedback';
    assert.equal((await fetch(origin+consent,{headers:{Origin:origin,'X-Canvas-Client':'ui'}})).status,403);
    assert.equal((await fetch(origin+consent,{headers:{Origin:origin,'X-Canvas-Token':token}})).status,403);
    assert.equal((await fetch(origin+consent,{headers:{...auth,Origin:'https://other.example'}})).status,403);
    assert.equal((await fetch(origin+record,{method:'POST',headers:auth,body:JSON.stringify(feedback())})).status,403);
    assert.equal((await fetch(origin+consent,{method:'PUT',headers:auth,body:JSON.stringify({enabled:true,expectedRevision:0})})).status,200);
    const result=await fetch(origin+record,{method:'POST',headers:auth,body:JSON.stringify(feedback())});
    assert.equal(result.status,201);
    const payload=await result.json() as {id:string; source:string; choice:string};
    assert.equal(payload.choice,'left');assert.equal(payload.source,'local_ui_unverified');
    assert.equal((await fetch(origin+record,{method:'POST',headers:auth,body:JSON.stringify(feedback())})).status,201);
    const state=await (await fetch(origin+'/api/state',{headers:auth})).text();
    assert.equal(state.includes('learningFeedback'),false);
    assert.equal((await fetch(origin+consent,{method:'PUT',headers:auth,body:JSON.stringify({enabled:false,expectedRevision:1})})).status,200);
    assert.equal(f.service.learningFeedbackStatus().recordCount,0);
  } finally {
    await new Promise<void>(resolve=>server.close(()=>resolve()));
    f.cleanup();
  }
});
test('feedback consent storage does not create automatic learning event journal', () => {
  const f=fixture();
  try {
    seed(f.store);f.service.setLearningFeedbackConsent({enabled:true,expectedRevision:0});
    f.service.recordLocalFeedback(feedback());
    assert.equal(readFileSync(f.store.file,'utf8').includes('"learningFeedback"'),true);
    assert.equal(f.store.read().learningOutbox?.length??0,0);
  } finally {f.cleanup();}
});
