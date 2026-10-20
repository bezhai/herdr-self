// The start action: opens the form popup. The popup reads the directory of the focused pane from its own plugin context.
import {spawnSync} from 'node:child_process';
import {herdrBin} from './herdr.mjs';import {PLUGIN_ID} from './config.mjs';
const r=spawnSync(herdrBin(),['plugin','pane','open','--plugin',PLUGIN_ID,'--entrypoint','form'],{encoding:'utf8',stdio:['ignore','pipe','pipe']});
process.stdout.write(r.stdout||'');process.stderr.write(r.stderr||(r.error?`${r.error.message}\n`:''));
process.exit(r.status??1);
