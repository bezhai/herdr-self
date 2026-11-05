// The Feishu cards (JSON 2.0) butler sends. Text from the model, the chats and the people always goes in plain text,
// so nothing in it is read as markdown or becomes a link; markdown is butler's own: colored dots. The only links are
// butler's, made from the source messages, and they go in components' link properties, never in text. Feishu checks a
// 2.0 card strictly and refuses one with a property it does not know, at send time, so only properties its card JSON
// 2.0 documentation lists are used.

// Where I talk to butler: a Feishu group that the herdr bridge binds to a Claude agent, which works butler through its
// command line (see cli.mjs). The direct chat with the bot only carries cards, so what a card says I can do beyond its
// buttons is done there.
export const AGENT_GROUP='herdr bridge 里绑定了管家 agent 的飞书群';

// Feishu refuses a card message whose request body exceeds 30 KB; the card travels serialized as a string inside
// that body (see bridge/message-cards.mjs, which keeps 28000 bytes for the same reason).
export const CARD_BYTES=28000;
// Feishu takes at most 200 components in a card, text objects (tag plain_text) counted among them.
export const MAX_COMPONENTS=200;
const SUMMARY=100,PLAIN=4000;
export const clip=(s,n)=>[...s].length>n?[...s].slice(0,n-1).join('')+'…':s;
const size=x=>Buffer.byteLength(JSON.stringify(JSON.stringify(x)));
// How many components x holds: everything with a tag, x itself included.
export const components=x=>Array.isArray(x)?x.reduce((n,y)=>n+components(y),0)
 :x&&typeof x==='object'?(typeof x.tag==='string'?1:0)+components(Object.values(x)):0;
// Whether Feishu takes the card: small enough, and few enough components.
export const fits=card=>size(card)<=CARD_BYTES&&components(card)<=MAX_COMPONENTS;

// style: the plain text's text_size and text_color.
export const plain=(content,style={})=>({tag:'div',text:{tag:'plain_text',content:clip(content,PLAIN),...style}});
// A dot in color, one of the card colors.
export const dot=color=>({tag:'markdown',content:`<font color='${color}'>●</font>`});
// A panel folded away until clicked, under a title of butler's: ▸ before it, turning to ▾ when it opens.
export const panel=(title,elements)=>({tag:'collapsible_panel',expanded:false,
 header:{title:{tag:'plain_text',content:title},icon:{tag:'standard_icon',token:'right-small-ccm_outlined',size:'16px 16px'},icon_position:'left',icon_expanded_angle:90},
 border:{color:'grey',corner_radius:'5px'},elements});
// Lines of plain text in as few elements as stay well within a card, each in style.
export function lines(list,style={}){
 const out=[];let part=[];
 for(const line of list){
  if(part.length&&Buffer.byteLength([...part,line].join('\n'))>PLAIN){out.push(plain(part.join('\n'),style));part=[];}
  part.push(line);
 }
 if(part.length)out.push(plain(part.join('\n'),style));
 return out;
}

// The elements in as few cards as they fit in, in order. title: a header for each card, numbered when there are
// several; summary: what the chat list and notifications show instead of the card.
export function cards(elements,{title,summary}){
 const make=(els,i,n)=>({schema:'2.0',config:{summary:{content:clip(summary.replace(/\s+/g,' ').trim(),SUMMARY)}},
  ...title&&{header:{title:{tag:'plain_text',content:n>1?`${title}（${i}/${n}）`:title},template:'blue'}},body:{elements:els}});
 // The numbered header of the last of up to 99 cards is the largest.
 const empty=make([],99,99),room=CARD_BYTES-size(empty),slots=MAX_COMPONENTS-components(empty);
 const parts=[[]];let used=0,count=0;
 for(const e of elements){
  const cost=size(e)+2,n=components(e);
  if(parts.at(-1).length&&(used+cost>room||count+n>slots)){parts.push([]);used=0;count=0;}
  parts.at(-1).push(e);used+=cost;count+=n;
 }
 return parts.map((els,i)=>make(els,i+1,parts.length));
}

// Cards of up to most items each, fewer when that is what fits, in order; make(items) is the card for some items. For
// cards whose buttons name the items on their own card, so that a click can make that card again.
export function paged(items,make,most){
 const out=[];
 for(let i=0;i<items.length;){
  let n=Math.min(most,items.length-i),card;
  while(!fits(card=make(items.slice(i,i+n)))&&n>1)n--;
  out.push(card);i+=n;
 }
 return out;
}
