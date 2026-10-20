// A stand-in for git in the tests: records its arguments in FAKE_GIT_LOG and runs the real git (FAKE_GIT_REAL), except for the
// subcommand named in FAKE_GIT_FAIL, which fails the way git does. The repositories it works on are throwaway ones of the test.
import fs from 'node:fs';import {spawnSync} from 'node:child_process';
const argv=process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_GIT_LOG,JSON.stringify(argv)+'\n');
let i=0;while(i<argv.length&&argv[i].startsWith('-'))i+=['-C','-c'].includes(argv[i])?2:1;
if(argv[i]===process.env.FAKE_GIT_FAIL){process.stderr.write(`fatal: ${argv[i]} failed for the test\n`);process.exit(128);}
process.exit(spawnSync(process.env.FAKE_GIT_REAL,argv,{stdio:'inherit'}).status??1);
