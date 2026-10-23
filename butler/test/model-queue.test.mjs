import test from 'node:test';
import assert from 'node:assert/strict';
import {ModelQueue} from '../model-queue.mjs';

test('one model run at a time: the owner\'s turns go ahead of waiting batches, in the order they came',async()=>{
 const order=[],gates=new Map();let busy=0,overlap=false;
 const model={async ask({prompt}){if(busy++)overlap=true;order.push(prompt);await new Promise(r=>gates.set(prompt,r));busy-=1;return `answer ${prompt}`;},async cleanup(){return 2;}};
 const q=new ModelQueue(model);
 const b1=q.ask({prompt:'b1'}),b2=q.ask({prompt:'b2'});
 await new Promise(r=>setImmediate(r));
 assert.deepEqual(q.state(),{running:'batch',waiting:1});
 const t1=q.run(()=>model.ask({prompt:'t1'}),{first:true,what:'turn'}),t2=q.run(()=>model.ask({prompt:'t2'}),{first:true,what:'turn'});
 assert.deepEqual(q.state(),{running:'batch',waiting:3});
 for(const p of ['b1','t1','t2','b2']){await new Promise(r=>setImmediate(r));gates.get(p)();}
 assert.deepEqual(await Promise.all([b1,b2,t1,t2]),['answer b1','answer b2','answer t1','answer t2']);
 assert.deepEqual(order,['b1','t1','t2','b2']);assert.equal(overlap,false);
 assert.deepEqual(q.state(),{running:undefined,waiting:0});
 assert.equal(await q.cleanup(),2,'cleanup goes through to the model');
 await assert.rejects(q.run(async()=>{throw Error('boom');}),/boom/);
 const after=q.ask({prompt:'after'});await new Promise(r=>setImmediate(r));gates.get('after')();
 assert.equal(await after,'answer after','a failed run does not hold up the next');
});
