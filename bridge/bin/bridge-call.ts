#!/usr/bin/env node
// bridge-call on a machine that runs a Bridge client (see service-command.ts).
import {main} from '../service-command.ts';
process.exitCode=await main(process.argv.slice(2));
