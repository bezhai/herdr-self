// When a digest goes out. Pure functions of the time, the last digest and how much there is to report; times are
// local. Working time (by default weekdays 10:00–20:00) has slots, one every everyMs from its start up to its end
// inclusive: a slot sends a digest when there is something new or ended, and passes over otherwise. A slot missed
// (butler was down) still counts until the next slot, and is dropped after. Outside working time a digest goes out
// only once offHoursNew new matters have come in, and no sooner than offHoursGapMs after the last digest.

// days: ISO weekdays (1 Monday … 7 Sunday); start, end: minutes after midnight.
export const DEFAULT_SCHEDULE={days:[1,2,3,4,5],start:600,end:1200,everyMs:3600e3,offHoursNew:3,offHoursGapMs:7200e3};
const DAY_MS=86400e3;

const duration=(v,what,min=1)=>{
 const m=/^(\d+)([mh])$/.exec(v);if(!m||Number(m[1])<min)throw Error(`${what}的格式不对：${v}（例如 30m、2h）`);
 return Number(m[1])*(m[2]==='h'?3600e3:60e3);
};
const clock=(v,what)=>{
 const m=/^(\d\d?):(\d\d)$/.exec(v);if(!m||Number(m[1])>24||Number(m[2])>59)throw Error(`${what}的格式不对：${v}（例如 10:00）`);
 return Number(m[1])*60+Number(m[2]);
};
// From the config's strings (any of them missing: the default): days like 1-5 or 1,3,5; hours like 10:00-20:00;
// every and offHoursGap like 30m or 2h; offHoursNew a count.
export function readSchedule({days,hours,every,offHoursNew,offHoursGap}={}){
 const s={...DEFAULT_SCHEDULE};
 if(days!==undefined){
  const out=new Set();
  for(const part of days.split(',')){
   const m=/^\s*([1-7])\s*(?:-\s*([1-7])\s*)?$/.exec(part);if(!m||m[2]&&m[2]<m[1])throw Error(`汇总的工作日格式不对：${days}（1 是周一，7 是周日，例如 1-5）`);
   for(let d=Number(m[1]);d<=Number(m[2]??m[1]);d++)out.add(d);
  }
  s.days=[...out].sort((a,b)=>a-b);
 }
 if(hours!==undefined){
  const [a,b,...rest]=hours.split('-');if(b===undefined||rest.length)throw Error(`汇总的工作时间格式不对：${hours}（例如 10:00-20:00）`);
  s.start=clock(a.trim(),'汇总的工作时间');s.end=clock(b.trim(),'汇总的工作时间');
  if(s.end<=s.start||s.end>1440)throw Error(`汇总的工作时间要在一天之内、先早后晚：${hours}`);
 }
 if(every!==undefined)s.everyMs=duration(every,'汇总的间隔');
 if(offHoursNew!==undefined){if(!/^\d+$/.test(offHoursNew)||Number(offHoursNew)<1)throw Error(`工作时间外发汇总的新事项数要是正整数：${offHoursNew}`);s.offHoursNew=Number(offHoursNew);}
 if(offHoursGap!==undefined)s.offHoursGapMs=duration(offHoursGap,'工作时间外两份汇总的间隔',0);
 return s;
}

const midnight=t=>{const d=new Date(t);return new Date(d.getFullYear(),d.getMonth(),d.getDate()).getTime();};
const workDay=(t,s)=>s.days.includes(new Date(t).getDay()||7);
// The slots of the day that begins at day0, if it is a working day.
function slots(day0,s){
 if(!workDay(day0,s))return [];
 const out=[],first=day0+s.start*60e3,last=day0+s.end*60e3;
 for(let t=first;t<=last;t+=s.everyMs)out.push(t);
 return out;
}
export const inWorkTime=(t,s)=>{const d=midnight(t);return workDay(t,s)&&t>=d+s.start*60e3&&t<d+s.end*60e3;};
// The slot t falls in: the latest one at or before t, until the next one would begin.
function slotOf(t,s){
 const found=slots(midnight(t),s).filter(x=>x<=t).at(-1);
 return found!==undefined&&t<found+s.everyMs?found:undefined;
}
// The first slot after t, within the coming week.
function slotAfter(t,s){
 for(let d=midnight(t),i=0;i<8;i++,d=midnight(d+DAY_MS+3600e3)){const found=slots(d,s).find(x=>x>t);if(found!==undefined)return found;}
 return undefined;
}

// now; last: the digest state ({at: when the last one went out, slot: the last slot handled}); fresh: new matters
// since then; ended: matters ended since then that count (see digest.mjs). Returns whether to send now, and the slot
// that this handles, when one does (to be recorded whether or not anything goes out).
export function decide({now,last={},fresh,ended,schedule:s}){
 const slot=slotOf(now,s);
 if(slot!==undefined&&!(last.slot>=slot))return {send:fresh+ended>0,slot};
 if(!inWorkTime(now,s)&&fresh>=s.offHoursNew&&!(now-last.at<s.offHoursGapMs))return {send:true};
 return {send:false};
}
// When the next digest goes out if nothing changes in between; undefined when there is nothing to send.
export function nextDigest({now,last={},fresh,ended,schedule:s}){
 if(!fresh&&!ended)return undefined;
 const slot=slotOf(now,s);
 let at=slot!==undefined&&!(last.slot>=slot)?now:slotAfter(now,s)??Infinity;
 if(fresh>=s.offHoursNew){
  // Outside working time, once the gap has passed: when that is in working time, at its end.
  const t=Math.max(now,(last.at??-Infinity)+s.offHoursGapMs);
  at=Math.min(at,inWorkTime(t,s)?midnight(t)+s.end*60e3:t);
 }
 return Number.isFinite(at)?at:undefined;
}
