// A stand-in for claude in the tests. Records its arguments, its stdin and the names of its HERDR_* variables in FAKE_CLAUDE_LOG, then
// does what the JSON in FAKE_CLAUDE says: {stdout, exit, sleepMs}.
import fs from 'node:fs';
const input=fs.readFileSync(0,'utf8');
fs.writeFileSync(process.env.FAKE_CLAUDE_LOG,JSON.stringify({argv:process.argv.slice(2),input,cwd:process.cwd(),herdrEnv:Object.keys(process.env).filter(k=>k.startsWith('HERDR_'))}));
const b=JSON.parse(process.env.FAKE_CLAUDE||'{}');
if(b.sleepMs)await new Promise(r=>setTimeout(r,b.sleepMs));
process.stdout.write(b.stdout||'');process.exit(b.exit??0);
