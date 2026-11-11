import {invalid,string} from './machine-tools.ts';
import type {Methods,ClientApi} from './link.ts';
// The owner's channel: open-lark, a Feishu web client logged in as the owner, which runs on one machine and listens there only. The client
// of that machine reads chats and messages and sends messages through open-lark's agent API (/agent/v1) as the owner, for the control
// plane (see ClientApi in link.ts, where the methods and their error codes are). The full token of open-lark, which can do whatever the
// owner can in Feishu, is in that client's config file only (see readConfig in client.ts): it never travels, never reaches the control
// plane, and is in the environment of no program that the client runs. Ids are open-lark's, not the open platform's ids of the bot. It
// uses only Node's built-in modules, like the client.

// openLark of the config of a client (see readConfig): url, the origin of open-lark's agent server on this machine, such as
// http://127.0.0.1:8081, and token, its full token.
export type OpenLark={url:string,token:string};
type OwnerMethods=Pick<Methods<ClientApi>,'openLarkMessage'|'openLarkChat'|'openLarkReply'|'openLarkSend'>;
// The methods of the owner's channel with open-lark at config, or, without one, methods that all reject with code channel_unconfigured.
export function openLarkMethods(config:OpenLark|undefined):OwnerMethods{
 const todo=()=>{throw Error('not implemented');};
 return {openLarkMessage:todo,openLarkChat:todo,openLarkReply:todo,openLarkSend:todo};
}
