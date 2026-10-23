// The Feishu cards (JSON 2.0) butler sends. Text from the model, the chats and the people always goes in plain text,
// so nothing in it is read as markdown or becomes a link; markdown is butler's own: headings it words, and links it
// made from the source messages.

// Feishu refuses a card message whose request body exceeds 30 KB; the card travels serialized as a string inside
// that body (see bridge/message-cards.mjs, which keeps 28000 bytes for the same reason).
export const CARD_BYTES=28000;
const MAX_ELEMENTS=100,SUMMARY=100,PLAIN=4000;
export const clip=(s,n)=>[...s].length>n?[...s].slice(0,n-1).join('')+'…':s;
const size=x=>Buffer.byteLength(JSON.stringify(JSON.stringify(x)));

export const plain=content=>({tag:'div',text:{tag:'plain_text',content:clip(content,PLAIN)}});
// text: butler's own words, without markdown characters.
export const heading=text=>({tag:'markdown',content:`**${text}**`});
// url: one butler made; parentheses and spaces would end the markdown link.
export const link=(text,url)=>({tag:'markdown',content:`[${text}](${url.replace(/[() ]/g,c=>({'(':'%28',')':'%29',' ':'%20'})[c])})`});
export const rule=()=>({tag:'hr'});
// Lines of plain text in as few elements as stay well within a card.
export function lines(list){
 const out=[];let part=[];
 for(const line of list){
  if(part.length&&Buffer.byteLength([...part,line].join('\n'))>PLAIN){out.push(plain(part.join('\n')));part=[];}
  part.push(line);
 }
 if(part.length)out.push(plain(part.join('\n')));
 return out;
}

// The elements in as few cards as they fit in, in order. title: a header for each card, numbered when there are
// several; summary: what the chat list and notifications show instead of the card.
export function cards(elements,{title,summary}){
 const make=(els,i,n)=>({schema:'2.0',config:{summary:{content:clip(summary.replace(/\s+/g,' ').trim(),SUMMARY)}},
  ...title&&{header:{title:{tag:'plain_text',content:n>1?`${title}（${i}/${n}）`:title},template:'blue'}},body:{elements:els}});
 // The numbered header of the last of up to 99 cards is the largest.
 const room=CARD_BYTES-size(make([],99,99));
 const parts=[[]];let used=0;
 for(const e of elements){
  const cost=size(e)+2;
  if(parts.at(-1).length&&(used+cost>room||parts.at(-1).length>=MAX_ELEMENTS)){parts.push([]);used=0;}
  parts.at(-1).push(e);used+=cost;
 }
 return parts.map((els,i)=>make(els,i+1,parts.length));
}
