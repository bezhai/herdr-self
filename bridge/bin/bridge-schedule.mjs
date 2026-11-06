#!/usr/bin/env node
// bridge-schedule on a machine that runs a Bridge client (see schedule-command.mjs).
import {main} from '../schedule-command.mjs';
process.exitCode=await main(process.argv.slice(2));
