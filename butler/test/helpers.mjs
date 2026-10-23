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

// A store of its own (no open-lark) and a way to put messages into it as the collector would have recorded them.
export function tempStore(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'butler-test-')),file=path.join(dir,'butler.db'),store=new Store(file,{linkBase:LINK_BASE});
 t.after(()=>{store.close();fs.rmSync(dir,{recursive:true,force:true});});
 return {store,dir,file};
}
let seq=0;
const CHATS={g1:['项目群','group'],g2:['大群','group'],d1:['张三','direct'],bot:['Zebra2.0自动化投放平台','direct']};
// o: chat (a key of CHATS), sender id, name, type, mine, text, at (ms), categories, threadRole, rootId, parentId.
export function post(store,o){
 const id=String(7200000000000000000n+BigInt(++seq)),chat=o.chat??'g1',[chatName,chatKind]=CHATS[chat]??[chat,'group'];
 store.upsertChatInfo({feedId:chat,name:chatName,chatMode:chatKind});
 const mine=Boolean(o.mine);
 store.upsertMessage({id,feedId:chat,chatKind,senderId:mine?'me':o.sender??'u1',senderName:mine?'原智鸿':o.name??'陈帆',senderType:o.type??'user',
  createdAt:o.at??Date.now(),position:String(seq),threadRole:o.threadRole??'none',rootId:o.rootId??null,parentId:o.parentId??null,replyToSenderId:null,
  text:o.text??'hi',parts:'[]',unreadable:false,isMine:mine,mentionsAll:false,isRecalled:false,isEdited:false,isEphemeral:false},o.categories??(chatKind==='direct'?['dm']:['watched']));
 return id;
}
