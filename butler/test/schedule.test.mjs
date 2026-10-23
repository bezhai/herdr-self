import test from 'node:test';
import assert from 'node:assert/strict';
import {DEFAULT_SCHEDULE,readSchedule,inWorkTime,decide,nextDigest} from '../schedule.mjs';

process.env.TZ='Asia/Shanghai';// working time is local time

// 2026-10-23 is a Friday; the 24th and 25th are the weekend.
const at=(day,hm)=>Date.parse(`2026-10-${day}T${hm}:00+08:00`);
const S=DEFAULT_SCHEDULE;
const run=(now,last,fresh,ended=0,schedule=S)=>decide({now,last,fresh,ended,schedule});

test('working time: one digest per hour slot, from 10:00 to 20:00 on weekdays',()=>{
 assert.ok(inWorkTime(at(23,'10:00'),S));assert.ok(inWorkTime(at(23,'19:59'),S));
 assert.ok(!inWorkTime(at(23,'09:59'),S));assert.ok(!inWorkTime(at(23,'20:00'),S));assert.ok(!inWorkTime(at(24,'12:00'),S),'Saturday');
 assert.deepEqual(run(at(23,'10:00'),{},1),{send:true,slot:at(23,'10:00')},'the first slot sends what there is');
 const last={at:at(23,'10:00'),slot:at(23,'10:00')};
 assert.deepEqual(run(at(23,'10:30'),last,5),{send:false},'one digest per slot, however much comes in');
 assert.deepEqual(run(at(23,'11:00'),last,0,1),{send:true,slot:at(23,'11:00')},'a matter that ended is a change too');
 assert.deepEqual(run(at(23,'20:00'),{at:at(23,'19:00'),slot:at(23,'19:00')},1),{send:true,slot:at(23,'20:00')},'20:00 is the last slot');
});

test('working time: a slot with nothing new and nothing ended sends nothing, and the next change waits for the next slot',()=>{
 const last={at:at(23,'10:00'),slot:at(23,'10:00')};
 assert.deepEqual(run(at(23,'11:00'),last,0,0),{send:false,slot:at(23,'11:00')},'the slot is passed over');
 assert.deepEqual(run(at(23,'11:20'),{...last,slot:at(23,'11:00')},2),{send:false},'no digest between slots');
 assert.deepEqual(run(at(23,'12:00'),{...last,slot:at(23,'11:00')},2),{send:true,slot:at(23,'12:00')});
});

test('a slot missed while butler was down is sent late within its hour, and dropped after it',()=>{
 const last={at:at(23,'14:00'),slot:at(23,'14:00')};
 assert.deepEqual(run(at(23,'15:40'),last,1),{send:true,slot:at(23,'15:00')});
 assert.deepEqual(run(at(23,'16:05'),last,1),{send:true,slot:at(23,'16:00')},'only the current slot counts');
 assert.deepEqual(run(at(23,'20:59'),{at:at(23,'19:00'),slot:at(23,'19:00')},1),{send:true,slot:at(23,'20:00')});
 assert.deepEqual(run(at(23,'21:00'),{at:at(23,'19:00'),slot:at(23,'19:00')},1),{send:false},'past the last slot it is outside working time');
});

test('outside working time: a digest only once new matters reach the threshold, at least two hours after the last one',()=>{
 const evening={at:at(23,'20:00'),slot:at(23,'20:00')};
 assert.deepEqual(run(at(23,'21:00'),evening,3),{send:false},'too soon after the last digest');
 assert.deepEqual(run(at(23,'22:00'),evening,2),{send:false},'too few new matters');
 assert.deepEqual(run(at(23,'22:00'),evening,3),{send:true});
 assert.deepEqual(run(at(23,'23:30'),evening,0,9),{send:false},'ended matters alone wait for working time');
 const night={at:at(23,'22:00'),slot:at(23,'20:00')};
 assert.deepEqual(run(at(24,'11:00'),night,3),{send:true},'the weekend is outside working time');
 assert.deepEqual(run(at(26,'08:00'),{at:at(24,'11:00')},4),{send:true},'so is Monday before 10:00');
 assert.deepEqual(run(at(23,'08:00'),{},3),{send:true},'the very first digest has no gap to wait for');
});

test('the next digest: when one would go out if nothing else changed',()=>{
 const next=(now,last,fresh,ended=0)=>nextDigest({now,last,fresh,ended,schedule:S});
 const morning={at:at(23,'10:00'),slot:at(23,'10:00')};
 assert.equal(next(at(23,'10:30'),morning,0,0),undefined,'nothing to send, nothing due');
 assert.equal(next(at(23,'10:30'),morning,1),at(23,'11:00'));
 assert.equal(next(at(23,'11:10'),morning,1),at(23,'11:10'),'a slot not yet handled is due now');
 assert.equal(next(at(23,'20:30'),{at:at(23,'20:00'),slot:at(23,'20:00')},1),at(26,'10:00'),'over the weekend to Monday');
 assert.equal(next(at(23,'20:30'),{at:at(23,'20:00'),slot:at(23,'20:00')},3),at(23,'22:00'),'enough new matters: after the gap');
 assert.equal(next(at(24,'12:00'),{at:at(24,'11:00')},4),at(24,'13:00'));
 assert.equal(next(at(23,'19:10'),{at:at(23,'19:00'),slot:at(23,'19:00')},3),at(23,'20:00'),'the 20:00 slot comes before the gap ends');
 const sparse={...S,everyMs:3*3600e3};// slots 10, 13, 16, 19
 assert.equal(nextDigest({now:at(23,'19:30'),last:{at:at(23,'19:00'),slot:at(23,'19:00')},fresh:3,ended:0,schedule:{...sparse,offHoursGapMs:600e3}}),at(23,'20:00'),
  'outside working time begins at 20:00 even without a slot there');
});

test('the schedule is configurable',()=>{
 assert.deepEqual(readSchedule({}),DEFAULT_SCHEDULE);
 const s=readSchedule({days:'1-3,6',hours:'09:30-18:00',every:'30m',offHoursNew:'5',offHoursGap:'90m'});
 assert.deepEqual(s,{days:[1,2,3,6],start:570,end:1080,everyMs:1800e3,offHoursNew:5,offHoursGapMs:5400e3});
 assert.deepEqual(run(at(24,'09:30'),{},1,0,s),{send:true,slot:at(24,'09:30')},'Saturday is a working day here');
 assert.deepEqual(run(at(23,'10:00'),{},1,0,s),{send:false},'Friday is not');
 assert.deepEqual(run(at(26,'10:00'),{at:at(26,'09:30'),slot:at(26,'09:30')},1,0,s),{send:true,slot:at(26,'10:00')},'every 30 minutes');
 for(const bad of [{days:'8'},{days:'周一'},{hours:'10-20'},{hours:'20:00-10:00'},{every:'0m'},{every:'1x'},{offHoursNew:'0'},{offHoursGap:'soon'}])
  assert.throws(()=>readSchedule(bad),Error,JSON.stringify(bad));
});
