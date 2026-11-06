import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {once} from 'node:events';
import {spawn} from 'node:child_process';
import {waitFor,LINK_BASE} from './helpers.mjs';
import {Store} from '../store.mjs';

// Another process holds the store's file locked for a while (args: file, ms), then lets it go and says when. It is a
// process of its own: a DatabaseSync waiting for a lock blocks the event loop of the process it runs in.
const HOLD=`
const {DatabaseSync}=require('node:sqlite');
const [file,ms]=process.argv.slice(1),db=new DatabaseSync(file);
db.exec('PRAGMA locking_mode=EXCLUSIVE;BEGIN EXCLUSIVE');
process.stdout.write('held\\n');
setTimeout(()=>{db.exec('COMMIT');db.close();process.stdout.write('released '+Date.now()+'\\n');},Number(ms));
`;

test('the store opens while another process holds its file for a moment, as when the collector and the processor start at once',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'butler-test-')),file=path.join(dir,'butler.db');
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 new Store(file,{linkBase:LINK_BASE}).close();
 const holder=spawn(process.execPath,['--disable-warning=ExperimentalWarning','-e',HOLD,file,'300'],{stdio:['ignore','pipe','inherit']});
 const exited=once(holder,'exit');let out='';holder.stdout.on('data',d=>out+=d);
 t.after(()=>holder.kill());
 await waitFor(()=>out.includes('held'),{message:'the other process to lock the store'});
 const before=Date.now(),store=new Store(file,{linkBase:LINK_BASE});
 t.after(()=>store.close());
 const [code]=await exited;assert.equal(code,0);
 assert.ok(before<Number(/released (\d+)/.exec(out)[1]),'the store was opened while the other process still held it');
 assert.equal(store.db.prepare('PRAGMA journal_mode').get().journal_mode,'wal');
});
