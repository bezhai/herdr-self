#!/usr/bin/env node
// bridge-message on a machine that runs a Bridge client (see message-command.ts).
import {main} from '../message-command.ts';
process.exitCode=await main(process.argv.slice(2));
