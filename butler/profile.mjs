// 关于TA: a few lines on my work (my role, the projects and services I work on, the people I work with, what is mine
// and what usually is not), which the model writes from my own messages and my notes, and which batches and reviews
// then judge by (see prompt.mjs): a message sent to me is not mine to do by that alone. The model gets my latest
// messages, each with the message it answered or, failing that, the one before it in its chat, and my notes,
// corrections in my own words (kept apart from it, see matters.mjs, so that a new profile never loses them). What my
// work is, and what is mine, is all the model's call: this only gathers what it is shown, the newest of my messages
// that fit one prompt, and returns what it wrote. When a profile is written is the processor's (see processor.mjs).
import {composeProfile,readProfile} from './prompt.mjs';

// options: maxPromptBytes, textChars, profileMessages (see processor.mjs DEFAULTS); notes: my notes; now: the clock.
// Resolves with the profile and how many of my messages it was written from, or undefined when there is nothing to
// write it from (no message of mine, no note); a run that fails is recorded as a failed run and rejects.
export async function writeProfile({matters,model,options,notes,now=Date.now}){
 const mine=matters.mine(options.profileMessages);
 if(!mine.length&&!notes.length)return undefined;
 // Each of mine with what it answered: the message it replied to, or the one before it in its chat.
 const shown=mine.map(m=>[m,(m.parentId&&matters.visible(m.parentId))||matters.before(m.chatId,m.createdAt,1)[0]].filter(Boolean));
 const compose=n=>composeProfile({now:now(),me:matters.me(),records:shown.slice(0,n).flat(),notes,textChars:options.textChars});
 const fits=n=>Buffer.byteLength(compose(n).prompt)<=options.maxPromptBytes;
 // The newest n that fit: all of them, or the most a binary search finds (one at least).
 let n=mine.length;
 if(n&&!fits(n)){let lo=1,hi=n-1;while(lo<hi){const mid=Math.ceil((lo+hi)/2);if(fits(mid))lo=mid;else hi=mid-1;}n=lo;}
 const {system,prompt}=compose(n);
 const text=await matters.recordRun({model,kind:'profile',messages:n,system,prompt,now},readProfile);
 return {text,messages:n};
}
