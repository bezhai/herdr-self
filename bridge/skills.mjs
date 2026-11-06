import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {enqueue} from './core.mjs';
// Bridge's own skills, which it places in the working directory of a topic's agent before the agent starts (see Topics.place): only the
// agents of Bridge's topics use them, so they belong in those directories, not in the global skill directories that every agent reads.
// One directory per skill, named after it, with its SKILL.md.
export const bundledSkills=path.join(path.dirname(fileURLToPath(import.meta.url)),'agent-instructions','skills');
// Where each machine keeps the skills as the deployed Bridge has them. No agent reads it as a global skill directory, unlike ~/.agents/skills,
// which Codex reads.
const store='~/.local/share/herdr-bridge/skills';
// Where the agent of each binding kind reads project skills, under its working directory, and how a skill goes there: as a link to the store,
// which Claude and Codex follow, or as a copy, since Antigravity follows no link (see placeSkills in machine.mjs).
const places={claude:{skills:'.claude/skills',as:'link'},codex:{skills:'.agents/skills',as:'link'},agy:{skills:'.agents/skills',as:'copy'}};
// The skills of directory dir: their names, their files as {relative path: base64}, and the digest of those, which changes with their content.
function bundle(dir){
 const names=fs.readdirSync(dir,{withFileTypes:true}).filter(e=>e.isDirectory()).map(e=>e.name).sort();
 const files=fs.readdirSync(dir,{recursive:true,withFileTypes:true}).filter(e=>e.isFile()).map(e=>path.relative(dir,path.join(e.parentPath,e.name))).sort().map(f=>[f,fs.readFileSync(path.join(dir,f),'base64')]);
 return {names,digest:crypto.createHash('sha256').update(JSON.stringify(files)).digest('hex'),files:Object.fromEntries(files)};
}
// Returns place(m, cwd, kind), which places the skills of dir, as they are now, where the agent of binding kind kind reads project skills in
// working directory cwd on machine m, whose leading ~/ is that machine's home: the request placeSkills to the client of m through call (see
// Clients.call), which gets the skills as data. It resolves to the paths of same-name skills that are not Bridge's, which the client left
// alone, and rejects when the placement fails. Placements on one machine run one after another, since they share its store.
export function skillPlacer(call,dir=bundledSkills){
 const queues=new Map();
 return (m,cwd,kind)=>enqueue(queues,m.id,()=>call(m,'placeSkills',{store,...bundle(dir),...places[kind],cwd}));
}
