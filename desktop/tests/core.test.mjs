import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeUrl, validState } from '../../shared/validation.mjs';
import { clipPane } from '../geometry.mjs';
import { WorkspaceStore } from '../storage.mjs';

const state = () => ({ version:1,theme:'light',profiles:[{id:'work',name:'Work',note:'',color:'#447b64'}],workspace:{id:'main',name:'Main',columns:2,rows:2,panes:[{id:'one',title:'Example',url:'https://example.com/',profileId:'work',kind:'external',addressOpen:false}]},savedSets:[] });
test('URL normalization rejects executable schemes and encoded overflow', () => {
  assert.equal(normalizeUrl('localhost:3000'), 'http://localhost:3000/');
  assert.equal(normalizeUrl('example.com:8080/path'), 'https://example.com:8080/path');
  assert.throws(()=>normalizeUrl('javascript:alert(1)'));
  assert.throws(()=>normalizeUrl('https://example.com/'+'가'.repeat(250)),/2048/);
});
test('state validation protects profile references and rejects malformed arrays without throwing',()=>{
  assert.equal(validState(state()),true);
  const wrong = state();wrong.workspace.panes[0].profileId='unknown';assert.equal(validState(wrong),false);
  assert.equal(validState({...state(),savedSets:[null]}),false);
  assert.equal(validState({...state(),profiles:[null]}),false);
});
test('clipping preserves native viewport dimensions and negative child offsets',()=>{
  assert.deepEqual(clipPane({x:50,y:10,width:400,height:300},{x:80,y:60,width:600,height:500}),{visible:true,container:{x:80,y:60,width:370,height:250},content:{x:-30,y:-50,width:400,height:300}});
  assert.equal(clipPane({x:0,y:0,width:50,height:50},{x:100,y:100,width:200,height:200}).visible,false);
  assert.throws(()=>clipPane({x:NaN,y:0,width:1,height:1},{x:0,y:0,width:1,height:1}));
});
test('atomic store persists latest state, retains a backup and recovers corrupted primary',async()=>{
  const path=await mkdtemp(join(tmpdir(),'mosaic-store-'));const store=new WorkspaceStore(path);
  assert.equal(store.load(),null);await store.save(state());
  const next=state();next.workspace.name='Saved work';await store.save(next);
  assert.equal(new WorkspaceStore(path).load().workspace.name,'Saved work');
  await assert.rejects(store.save({invalid:true}));
  assert.equal(JSON.parse(await readFile(join(path,'workspace.json'),'utf8')).workspace.name,'Saved work');
  await writeFile(join(path,'workspace.json'),'{broken');assert.equal(new WorkspaceStore(path).load().workspace.name,'Main');
});
