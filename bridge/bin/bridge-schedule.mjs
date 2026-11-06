#!/usr/bin/env node
// bridge-schedule on the Bridge host (see schedule-command.mjs).
import {main} from '../schedule-command.mjs';
process.exitCode=await main(process.argv.slice(2));
