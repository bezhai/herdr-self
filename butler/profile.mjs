// 关于TA: a few lines in two parts, which the model writes and batches, reviews and grading then judge
// by (see prompt.mjs). Work: my role, team, the projects and systems I work on, the people I work with, what is mine
// and what usually is not, so that a message sent to me is not mine to do by that alone. Interests: what I care about
// outside my work, which grading weighs (see grader.mjs). The model gets my latest messages, each with the message it
// answered or, failing that, the one before it in its chat; where I take part (the chats where I did most in the last
// month, and the busy ones I muted, with their levels); my notes, corrections in my own words kept apart from it (see
// matters.mjs) so that a new profile never loses them and never puts words in my mouth; the matters I marked as not
// mine; the chats whose level I set, and those the last exam got wrong (see grader.mjs), which it generalises into the
// profile; and the last profile, to say what it newly inferred. What my work is, what I care about and what is mine is
// all the model's call: this only gathers what it is shown, the newest of my messages that fit one prompt, and returns
// what it wrote. When a profile is written is the processor's (see processor.mjs).
import {composeProfile,readProfile} from './prompt.mjs';

// options: maxPromptBytes, textChars, profileMessages, notMine, profileChats, activeMs, involvementMs (see processor.mjs
// DEFAULTS); notes: my notes; previous: the last profile's text, if any; now: the clock. Resolves with the profile, what
// the model says it newly inferred and how many of my messages it was written from, or undefined when there is nothing
// to write it from (no message of mine, note, matter marked as not mine or level I set: where I take part alone, an @
// of me or a reaction of mine, says too little); a run that fails is recorded as a failed run and rejects.
export async function writeProfile({matters,model,options:o,notes,previous=null,now=Date.now}){
 const t=now(),mine=matters.mine(o.profileMessages),notMine=matters.notMine(o.notMine);
 const involvement=matters.involvedChats({now:t,since:t-o.activeMs,mineSince:t-o.involvementMs,limit:o.profileChats});
 // The last exam's wrong answers, as far as my level is still the one it was asked about.
 const corrections=matters.store.levels().filter(l=>l.by==='owner'),set=new Map(corrections.map(l=>[l.feedId,l.level]));
 const missed=(matters.exams(1)[0]?.wrong??[]).filter(w=>set.get(w.feedId)===w.owner);
 if(!mine.length&&!notes.length&&!notMine.length&&!corrections.length)return undefined;
 // Each of mine with what it answered: the message it replied to, or the one before it in its chat.
 const shown=mine.map(m=>[m,(m.parentId&&matters.visible(m.parentId))||matters.before(m.chatId,m.createdAt,1)[0]].filter(Boolean));
 const compose=n=>composeProfile({now:t,me:matters.me(),meId:matters.meId(),records:shown.slice(0,n).flat(),notes,notMine,previous,involvement,corrections,missed,textChars:o.textChars});
 const fits=n=>Buffer.byteLength(compose(n).prompt)<=o.maxPromptBytes;
 // The newest n that fit: all of them, or the most a binary search finds (one at least).
 let n=mine.length;
 if(n&&!fits(n)){let lo=1,hi=n-1;while(lo<hi){const mid=Math.ceil((lo+hi)/2);if(fits(mid))lo=mid;else hi=mid-1;}n=lo;}
 const {system,prompt}=compose(n);
 const {text,added}=await matters.recordRun({model,kind:'profile',messages:n,system,prompt,now},readProfile);
 return {text,added,messages:n};
}
