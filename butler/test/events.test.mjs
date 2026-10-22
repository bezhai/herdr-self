import test from 'node:test';
import assert from 'node:assert/strict';
import {startFakeOpenLark} from './fake-open-lark.mjs';
import {EventStream} from '../events.mjs';
import {waitFor,sleep} from './helpers.mjs';

const stream=(lark,extra)=>new EventStream({url:`${lark.url.replace('http','ws')}/agent/v1/events`,token:lark.token,minDelayMs:20,maxDelayMs:50,connectTimeoutMs:200,onEvent:()=>{},...extra});

test('a connection attempt that is never answered is given up and retried',async t=>{
 const lark=await startFakeOpenLark();t.after(()=>lark.close());
 let opens=0,closes=0;lark.hangUpgrades=true;
 const s=stream(lark,{connectTimeoutMs:100,onOpen:()=>{opens+=1;},onClose:()=>{closes+=1;}});t.after(()=>s.stop());
 s.start();await sleep(250);assert.equal(opens,0);assert.ok(closes>=1,'the hung attempt counts as a failed connection');
 lark.hangUpgrades=false;await waitFor(()=>opens===1,{message:'open after open-lark answers again'});
});

test('the token goes in the Authorization header and a refused token keeps retrying',async t=>{
 const lark=await startFakeOpenLark();t.after(()=>lark.close());
 let opens=0,refused=0;
 const s=stream(lark,{token:'wrong',onOpen:()=>{opens+=1;},onClose:c=>{if(!c.opened)refused+=1;}});t.after(()=>s.stop());
 s.start();await waitFor(()=>refused>=2,{message:'retries'});assert.equal(opens,0);
 s.stop();
 const ok=stream(lark,{onOpen:()=>{opens+=1;}});t.after(()=>ok.stop());ok.start();await waitFor(()=>opens===1);
 assert.ok(lark.requests.filter(r=>r.upgrade).every(r=>!r.query.token),'no token in the query string');
});
