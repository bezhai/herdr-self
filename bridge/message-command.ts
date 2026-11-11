import {clientSocket,send} from './client.ts';
import {sourceLine} from './outbound-cards.ts';
import type {Output} from './client.ts';
import type {MessageOps,MessageRequest} from './messages.ts';
// bridge-message, the command line through which the agent of a Feishu topic brings a Feishu message into its topic and drafts messages
// that the owner sends as themselves after a click on the draft's card (see Messages). Like bridge-schedule (see schedule-command.ts), it
// sends each request to the Bridge client of the machine it runs on, which passes it on to the control plane, with the agent's pane
// (HERDR_PANE_ID) and Herdr session (HERDR_SESSION); it runs on Node alone, like the client, and prints text for the agent, or with --json
// Bridge's answer. Its help is complete on its own: the skill that tells agents when to use it leaves the details of the command to it.
export const usage='';
// Runs bridge-message with argv, printing to stdout and stderr; resolves to the exit code. It reaches the client at clientSocket(env).
export async function main(argv:string[],{env=process.env,stdout=process.stdout,stderr=process.stderr}:{env?:NodeJS.ProcessEnv,stdout?:Output,stderr?:Output}={}):Promise<number>{
 throw Error('not implemented');
}
