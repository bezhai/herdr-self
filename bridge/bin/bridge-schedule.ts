#!/usr/bin/env node
// bridge-schedule on a machine that runs a Bridge client (see schedule-command.ts).
import {main} from '../schedule-command.ts';
process.exitCode=await main(process.argv.slice(2));
