import {plain,clip} from './request-cards.ts';
// Feishu cards (JSON 2.0) without a header for everything else that Bridge posts into a thread (see Topics and ChatBindings): the replies
// of an agent as markdown, and notices as plain text, so that text from Herdr, the agent or an error is never read as markdown.
// Feishu shows the summary of a card in the chat list and in notifications instead of a card placeholder: here the beginning of the text
// with its whitespace collapsed. The chat list shows one line of it and a notification a few lines, which 100 code points fill; a short
// summary also takes little of the room of a reply card (see replyCards).
const summaryLength=100;
export const untitled=(text:string,elements:object[],config?:object)=>({schema:'2.0',config:{...config,summary:{content:clip(text.replace(/\s+/g,' ').trim(),summaryLength)}},body:{elements}});
// Notices are a line or a few: they keep the default width.
export const notice=(text:string)=>untitled(text,[plain(text)]);
// Feishu refuses a card message whose request body exceeds 30 KB. The body carries the card serialized as the string value of its content
// field, beside some 60 bytes of other fields; a card within 28000 bytes there stays under 30 KB whether a KB is 1000 or 1024 bytes.
const maxBytes=28000;
// The bytes of x as that content field: serialized, then serialized again as a string inside the body.
const size=(x:unknown)=>Buffer.byteLength(JSON.stringify(JSON.stringify(x)));
// Whether card fits one message.
export const fits=(card:object)=>size(card)<=maxBytes;
// What string s adds to that size where a card holds it. Serializing escapes each character on its own and a surrogate pair as a whole,
// so the costs of pieces that split no pair add up to the cost of the whole.
const cost=(s:string)=>size(s)-6;
// Herdr cuts long replies. The note says so after the markdown of the last card, outside any code block that the cut left open.
const truncated='（回复过长，已截断，完整内容请在 Herdr 中查看）';
// Replies often hold code and tables: their cards take the full width.
const replyCard=(markdown:string,note:string)=>untitled(markdown,[{tag:'markdown',content:markdown},...note?[plain(note)]:[]],{width_mode:'fill'});
// A reply of an agent as Herdr reports it.
export type Reply={seq:number,text:string,truncated?:boolean};
// The cards of reply r of an agent ({text, truncated?} from Herdr), in the order they go out. A part of the text gets what a card with
// the note and the costliest summary leaves, a summary whose code points all serialize as \u0000.
export function replyCards(r:Pick<Reply,'text'|'truncated'>){
 const note=r.truncated?truncated:'',list=parts(r.text,maxBytes-size(replyCard('',note))-cost('\0'.repeat(summaryLength)));
 return list.map((markdown,i)=>replyCard(markdown,i===list.length-1?note:''));
}
// A fence line: indentation, then three or more backticks or tildes, then an info string, which has no backtick after backticks.
const fence=/^(\s*)(`{3,}(?!.*`)|~{3,})(.*)$/;
// The code block open after line, given the one open before it, as {line, close}: the fence line that opened it and the line that
// closes it. A fence opens a block, and closes the open one when it repeats its character at least as often and has no info string.
type Block={line:string,close:string}|null;
function block(open:Block,line:string):Block{
 const m=line.match(fence);if(!m)return open;
 if(!open)return {line,close:m[1]+m[2]};
 const marker=open.close.trim();return m[2][0]===marker[0]&&m[2].length>=marker.length&&!m[3].trim()?null:open;
}
// Splits markdown text into parts that cost at most room each (see cost): between lines, and inside a line only where it does not fit a
// part of its own, at code points. A part that ends inside a code block closes it, and the next part opens it again with its fence line.
// A fence line that costs more than a quarter of the room counts as text, so that a part always has room besides the fence lines.
function parts(text:string,room:number){
 const out:string[]=[];let lines:string[]=[],used=0,open:Block=null;
 const add=(line:string)=>{used+=(lines.length?cost('\n'):0)+cost(line);lines.push(line);};
 const part=()=>[...lines,...open?[open.close]:[]].join('\n');
 const flush=()=>{out.push(part());lines=[];used=0;if(open)add(open.line);};
 // What a line can still cost in the part, which then has to close the block open after the line.
 const left=(after:Block)=>room-used-(lines.length?cost('\n'):0)-(after?cost('\n'+after.close):0);
 for(const line of text.split('\n')){
  const after:Block=cost(line)>room/4?open:block(open,line);
  // A part that holds nothing but the fence line it opens again with goes on.
  if(cost(line)>left(after)&&lines.length>(open?1:0))flush();
  let rest=[...line];
  while(cost(rest.join(''))>left(after)){let n=0;for(let c=left(open);n<rest.length&&cost(rest[n])<=c;)c-=cost(rest[n++]);add(rest.slice(0,n).join(''));rest=rest.slice(n);flush();}
  add(rest.join(''));open=after;
 }
 out.push(part());return out;
}
