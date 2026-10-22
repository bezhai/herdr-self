import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {startFakeOpenLark} from './fake-open-lark.mjs';
import {Store} from '../store.mjs';
import {Collector} from '../collector.mjs';

export const LINK_BASE='http://127.0.0.1:3333';
// Fast timers; periodic work is effectively off so each test triggers reconciliation itself.
export const FAST={cycleMs:3600e3,threadFeedEveryMs:3600e3,mentionsEveryMs:3600e3,slackMs:0,reconnectMinMs:20,reconnectMaxMs:50,connectTimeoutMs:500,startupRetryMs:30,heartbeatMs:3600e3,requestGapMs:0,threadFetchDelayMs:10,threadAttempts:3,readAttempts:3};

export async function waitFor(check,{timeout=3000,message='condition'}={}){
 const end=Date.now()+timeout;
 for(;;){const value=await check();if(value)return value;if(Date.now()>end)throw Error(`timed out waiting for ${message}`);await new Promise(r=>setTimeout(r,10));}
}
export const sleep=ms=>new Promise(r=>setTimeout(r,ms));

// A fake open-lark, a store in a temporary directory and a way to (re)start collectors on it.
export async function setup(t,{options={}}={}){
 const lark=await startFakeOpenLark(),dir=fs.mkdtempSync(path.join(os.tmpdir(),'butler-test-')),file=path.join(dir,'butler.db');
 const store=new Store(file,{linkBase:LINK_BASE}),collectors=[];
 const collector=(extra={})=>{const c=new Collector({store,url:lark.url,token:lark.token,options:{...FAST,...options,...extra}});collectors.push(c);return c;};
 t.after(async()=>{for(const c of collectors)await c.stop();await lark.close();store.close();fs.rmSync(dir,{recursive:true,force:true});});
 return {lark,store,dir,file,collector,
  // Starts a collector and waits until its first reconciliation (and the one after the event socket opened) is done.
  async running(extra){const c=collector(extra);await c.start();await waitFor(()=>c.connected,{message:'event socket'});await c.idle();return c;}};
}
