#!/usr/bin/env node
// bridge-skill on a machine that runs a Bridge client, or wherever the owner manages the skills of the platform (see skill-command.ts).
import {main} from '../skill-command.ts';
process.exitCode=await main(process.argv.slice(2));
