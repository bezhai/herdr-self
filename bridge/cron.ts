// The cron expressions of schedules (see schedules.ts): the five fields of Vixie cron, minute, hour, day of month, month and day of week,
// each a comma list of *, a number or a range a-b, any of them with a step /n, where n/step counts from n to the end of the field. Months
// and days of week also take their English three-letter names, and 7 is Sunday like 0. Nothing else: no seconds, no macros such as @daily,
// no ? L W # of other schedulers. Runs are whole minutes of the wall clock of an IANA time zone. A wall time that a daylight saving change
// skips has no run that day; one that it repeats runs once, at its first occurrence.
const fields=[{label:'分钟',min:0,max:59},{label:'小时',min:0,max:23},{label:'日期',min:1,max:31},
 {label:'月份',min:1,max:12,names:['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec']},{label:'星期',min:0,max:7,names:['sun','mon','tue','wed','thu','fri','sat']}];
// The values of the text of field f, or throws.
function values(text,{label,min,max,names}){
 const invalid=part=>Error(`${label}字段无效：${part}`),out=new Set();
 for(const part of text.split(',')){
  const m=/^(?:(\*)|([a-z0-9]+)(?:-([a-z0-9]+))?)(?:\/([0-9]+))?$/i.exec(part);if(!m)throw invalid(part);
  const value=s=>{const i=names?.indexOf(s.toLowerCase())??-1,v=i>=0?min+i:/^[0-9]+$/.test(s)?Number(s):NaN;if(!(v>=min&&v<=max))throw invalid(part);return v;};
  const from=m[1]?min:value(m[2]),to=m[1]?max:m[3]!=null?value(m[3]):m[4]?max:from,step=m[4]?Number(m[4]):1;
  if(from>to||step<1)throw invalid(part);
  for(let v=from;v<=to;v+=step)out.add(v);
 }
 return out;
}
// Parses a cron expression into {minutes, hours} in ascending order, {days, months, weekdays} as sets and whether day of month or day of
// week starts with *. Throws with what is wrong.
export function parseCron(expression){
 const parts=String(expression??'').trim().split(/\s+/).filter(Boolean);
 if(parts.length!==5)throw Error(`时间表达式需要 5 个字段（分 时 日 月 星期），收到 ${parts.length} 个`);
 const [minutes,hours,days,months,weekdays]=parts.map((p,i)=>values(p,fields[i]));
 return {minutes:[...minutes].sort((x,y)=>x-y),hours:[...hours].sort((x,y)=>x-y),days,months,weekdays:new Set([...weekdays].map(d=>d%7)),
  anyDay:parts[2].startsWith('*'),anyWeekday:parts[4].startsWith('*')};
}
// Whether cron c runs on a date: in one of its months, and when day of month and day of week are both restricted on either of them, as
// cron does; when one of them starts with *, on both.
function runsOn(c,[year,month,day]){
 const dom=c.days.has(day),dow=c.weekdays.has(new Date(Date.UTC(year,month-1,day)).getUTCDay());
 return c.months.has(month)&&(c.anyDay||c.anyWeekday?dom&&dow:dom||dow);
}
// An IANA time zone that Intl knows, in its canonical form, or throws.
export function zone(timeZone){
 if(typeof timeZone!=='string'||!timeZone)throw Error('时区无效');
 try{return new Intl.DateTimeFormat('en-US',{timeZone}).resolvedOptions().timeZone;}catch{throw Error('时区无效：'+timeZone);}
}
const formats=new Map();
// The wall time of instant ms in timeZone, as [year, month, day, hour, minute].
function wall(ms,timeZone){
 let f=formats.get(timeZone);
 if(!f)formats.set(timeZone,f=new Intl.DateTimeFormat('en-US',{timeZone,hourCycle:'h23',year:'numeric',month:'numeric',day:'numeric',hour:'numeric',minute:'numeric'}));
 const p=Object.fromEntries(f.formatToParts(ms).map(x=>[x.type,Number(x.value)]));return [p.year,p.month,p.day,p.hour,p.minute];
}
const asUtc=([year,month,day,hour,minute])=>Date.UTC(year,month-1,day,hour,minute);
// The offset of timeZone at instant ms: its wall time read as UTC, minus ms.
const offset=(ms,timeZone)=>asUtc(wall(ms,timeZone))-Math.floor(ms/60000)*60000;
const dayMs=86400000;
// The instant of the wall time that reads as utc in UTC, in timeZone, or null when a daylight saving change skips it; when one repeats it,
// the first. The offsets a day before and a day after differ only around such a change, and then each gives one candidate.
function instant(utc,timeZone){
 const before=offset(utc-dayMs,timeZone),after=offset(utc+dayMs,timeZone);
 if(before===after)return utc-before;
 const found=[utc-before,utc-after].filter(x=>asUtc(wall(x,timeZone))===utc);return found.length?Math.min(...found):null;
}
// February 29 on a Monday, or February 29 alone across a century year, can be eight years away.
const horizon=8*366;
// The first run of cron c in timeZone from instant from on, a whole minute, in the direction of step: 1 forward, -1 backward, from
// included; null within the horizon. A day whose offset is the same a day before and two days after has no daylight saving change, and
// its wall times convert without asking Intl. On the first day, wall times more than three hours on the far side of from's are passed over:
// no daylight saving change moves the clock that far.
function find(c,timeZone,from,step){
 const [year,month,day,hour,minute]=wall(from,timeZone),hours=step>0?c.hours:[...c.hours].reverse(),minutes=step>0?c.minutes:[...c.minutes].reverse();
 for(let k=0;k<=horizon;k++){
  const d=new Date(Date.UTC(year,month-1,day+step*k)),date=[d.getUTCFullYear(),d.getUTCMonth()+1,d.getUTCDate()];
  if(!runsOn(c,date))continue;
  const midnight=d.getTime(),before=offset(midnight-dayMs,timeZone),steady=before===offset(midnight+2*dayMs,timeZone);
  for(const h of hours)for(const m of minutes){
   if(k===0&&((h-hour)*60+m-minute)*step<-180)continue;
   const utc=midnight+(h*60+m)*60000,t=steady?utc-before:instant(utc,timeZone);if(t!=null&&(t-from)*step>=0)return t;
  }
 }
 return null;
}
// The first run of cron c in timeZone strictly after instant after, or null when there is none.
export const next=(c,timeZone,after)=>find(c,timeZone,Math.floor(after/60000)*60000+60000,1);
// The latest run of cron c in timeZone strictly before instant before, or null.
export const previous=(c,timeZone,before)=>find(c,timeZone,Math.floor((before-1)/60000)*60000,-1);
// The next count runs of cron c in timeZone after instant after; fewer when it runs no more.
export function upcoming(c,timeZone,after,count){
 const out=[];for(let t=after;out.length<count&&(t=next(c,timeZone,t))!=null;)out.push(t);return out;
}
const pad=n=>String(n).padStart(2,'0');
const weekdays=['日','一','二','三','四','五','六'];
// Instant ms as the wall time of timeZone, such as 2026-11-09 09:30, or with weekday 2026-11-09 周一 09:30.
export function when(ms,timeZone,{weekday=false}={}){
 const [year,month,day,hour,minute]=wall(ms,timeZone),date=`${year}-${pad(month)}-${pad(day)}`;
 return `${date} ${weekday?'周'+weekdays[new Date(Date.UTC(year,month-1,day)).getUTCDay()]+' ':''}${pad(hour)}:${pad(minute)}`;
}
// values (ascending) in words joined by 、, three or more consecutive ones as a range from one to the other joined by to.
function spans(values,name=String,to=' 至 '){
 const out=[];
 for(let i=0;i<values.length;){
  let j=i;while(j+1<values.length&&values[j+1]===values[j]+1)j++;
  if(j-i>=2)out.push(name(values[i])+to+name(values[j]));else for(let k=i;k<=j;k++)out.push(name(values[k]));
  i=j+1;
 }
 return out.join('、');
}
// The step of values (ascending, of a field from min to max) when they are every step-th value of the field from the first, the first
// below step, and step divides the field, so that the step holds across the end of the field too: */5 in minutes, 2/5, */2 in hours. 0 else.
function step(values,min,max){
 const s=values[1]-values[0];
 return values.length>1&&values[0]-min<s&&(max-min+1)%s===0&&values.every((v,i)=>v===values[0]+i*s)&&values.at(-1)+s>max?s:0;
}
const consecutive=values=>values.every((v,i)=>!i||v===values[i-1]+1);
const sorted=set=>[...set].sort((x,y)=>x-y);
// The days of cron c in words: every day, the days of month, the days of week (Monday first), or both, within the months it names.
function days(c){
 const month=c.months.size<12,dom=c.days.size<31,dow=c.weekdays.size<7,within=month?`每年 ${spans(sorted(c.months))} 月的`:'';
 const dates=`${month?' ':'每月 '}${spans(sorted(c.days))} 日`,week=spans(sorted(new Set([...c.weekdays].map(d=>d||7))),d=>'周'+weekdays[d%7],'至');
 // Both restricted and neither starting with *: either one, so one that names every day makes it every day (see runsOn).
 const either=!c.anyDay&&!c.anyWeekday;
 return within+(either&&!(dom&&dow)?'每天':dom&&dow?(either?`${dates}和每${week}`:`${dates}中的${week}`):dom?dates:dow?'每'+week:'每天');
}
// The times of day of cron c in words: up to six times as such, a step of minutes or hours, once an hour, or else the hours and minutes.
function times(c){
 const {minutes:m,hours:h}=c,ms=step(m,0,59),hs=m.length===1&&step(h,0,23);
 if(m.length*h.length<=6)return h.flatMap(x=>m.map(y=>`${pad(x)}:${pad(y)}`)).join('、');
 if(ms&&h.length===24)return `每 ${ms} 分钟${m[0]?`（每小时第 ${m[0]} 分钟起）`:''}`;
 if(ms&&consecutive(h))return `${pad(h[0])}:${pad(m[0])} 至 ${pad(h.at(-1))}:${pad(m.at(-1))} 每 ${ms} 分钟`;
 if(hs===1)return m[0]?`每小时第 ${m[0]} 分钟`:'每小时整点';
 if(hs)return `每 ${hs} 小时，从 ${pad(h[0])}:${pad(m[0])} 起`;
 if(m.length===1&&consecutive(h))return `${pad(h[0])}:${pad(m[0])} 至 ${pad(h.at(-1))}:${pad(m[0])} 每小时一次`;
 return `${spans(h)} 点的第 ${spans(m)} 分钟`;
}
// Cron c in plain words, such as 每周一至周五 09:30 or 每 5 分钟, for a person to check against what they asked for (see schedule-cards.ts).
export function phrase(c){const d=days(c),t=times(c);return d==='每天'&&t.startsWith('每')?t:`${d} ${t}`;}
