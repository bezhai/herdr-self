#!/usr/bin/env node
// bridge-task on a machine that runs a Bridge client (see task-command.ts).
import { main } from '../task-command.ts';
process.exitCode = await main(process.argv.slice(2));
