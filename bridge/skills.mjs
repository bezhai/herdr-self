import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
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
// which Claude and Codex follow, or as a copy, since Antigravity follows no link.
const places={claude:{dir:'.claude/skills',as:'link'},codex:{dir:'.agents/skills',as:'link'},agy:{dir:'.agents/skills',as:'copy'}};
// The script that places the skills on a machine, with the store as $1, the digest of the skills as $2, the skills directory under the working
// directory as $3, link or copy as $4, the working directory as $5 and the names of the skills after them, and the skills as a tar archive on
// stdin, which it reads only when the store holds other content: it then replaces the store whole. A skill of the working directory is
// Bridge's when it is a link to the store or a directory with Bridge's marker, which holds the digest of the skills it was copied from; a
// copy is written again when the digest changed, and a link of Bridge's that a copy has to replace is replaced. Anything else of that name
// is someone else's: it stays as it is and its path is printed. In a Git repository each skill of Bridge's goes into the info/exclude of the
// repository that holds where it actually is, which a link in the path such as .claude/skills -> ../.agents/skills can change, as its path
// from the top level of that repository; linked worktrees share that file. Exits non-zero on the first step that fails.
const placeScript=`store=$1 digest=$2 skills=$5/$3 as=$4 mark=.herdr-bridge-skill
shift 5
if [ "$(cat "$store/.digest" 2>/dev/null)" != "$digest" ]; then
 mkdir -p -- "$(dirname -- "$store")" && new=$(mktemp -d "$store.XXXXXX") || exit 1
 { tar -xf - -C "$new" && printf '%s\\n' "$digest" > "$new/.digest" && rm -rf -- "$store" && mv -- "$new" "$store"; } || { rm -rf -- "$new"; exit 1; }
fi
copy(){ rm -rf -- "$1" && mkdir -- "$1" && : > "$1/$mark" && cp -R -- "$store/$name/." "$1" && printf '%s\\n' "$digest" > "$1/$mark"; }
mkdir -p -- "$skills" && real=$(cd -P -- "$skills" && pwd) || exit 1
top=$(git -C "$real" rev-parse --show-toplevel 2>/dev/null) && exclude=$(git -C "$real" rev-parse --git-path info/exclude 2>/dev/null) || exclude=
case $exclude in ''|/*) ;; *) exclude=$real/$exclude;; esac
case $real/ in "$top"/*) ;; *) exclude=;; esac
for name; do
 p=$skills/$name
 if [ -L "$p" ]; then
  [ "$(readlink "$p")" = "$store/$name" ] || { printf '%s\\n' "$p"; continue; }
  [ "$as" = link ] || { rm -f -- "$p" && copy "$p"; } || exit 1
 elif [ -e "$p" ]; then
  [ -f "$p/$mark" ] || { printf '%s\\n' "$p"; continue; }
  [ "$(cat "$p/$mark")" = "$digest" ] || copy "$p" || exit 1
 elif [ "$as" = link ]; then ln -s -- "$store/$name" "$p" || exit 1
 else copy "$p" || exit 1
 fi
 [ -n "$exclude" ] || continue
 line=\${real#"$top"}/$name
 grep -qxF -- "$line" "$exclude" 2>/dev/null && continue
 mkdir -p -- "$(dirname -- "$exclude")" && { [ ! -s "$exclude" ] || [ -z "$(tail -c 1 "$exclude")" ] || echo; printf '%s\\n' "$line"; } >> "$exclude" || exit 1
done`;
// The skills of directory dir: their names, the digest of their files, which changes with their content, and a tar archive of them.
async function bundle(dir){
 const names=fs.readdirSync(dir,{withFileTypes:true}).filter(e=>e.isDirectory()).map(e=>e.name).sort();
 const files=fs.readdirSync(dir,{recursive:true,withFileTypes:true}).filter(e=>e.isFile()).map(e=>path.relative(dir,path.join(e.parentPath,e.name))).sort();
 const digest=crypto.createHash('sha256').update(JSON.stringify(files.map(f=>[f,fs.readFileSync(path.join(dir,f),'base64')]))).digest('hex');
 const {stdout:archive}=await promisify(execFile)('tar',['-cf','-','-C',dir,...names],{encoding:'buffer'});
 return {names,digest,archive};
}
// Returns place(m, cwd, kind), which places the skills of dir, as they are now, where the agent of binding kind kind reads project skills in
// working directory cwd on machine m, whose leading ~/ is that machine's home: one command through exec (see core.mjs), which gets the skills
// on stdin, never on its command line. It resolves to the paths of same-name skills that are not Bridge's, which it left alone, and rejects
// when the command fails. Placements on one machine run one after another, since they share its store.
export function skillPlacer(exec,dir=bundledSkills){
 const queues=new Map();
 return (m,cwd,kind)=>enqueue(queues,m.id,async()=>{
  const {names,digest,archive}=await bundle(dir),{dir:at,as}=places[kind];
  const r=await exec(m,['sh','-c',placeScript,'sh',{path:store},digest,at,as,{path:cwd},...names],{input:archive});
  if(r.code!==0)throw Error((r.stderr||r.stdout).trim()||`退出码 ${r.code}`);
  return r.stdout.split('\n').filter(l=>l.startsWith('/'));
 });
}
