// An editable text with a cursor, for the fields of the popup form. cursor is a UTF-16 index at a grapheme boundary, so an emoji or a
// letter with a combining mark moves and deletes as one character.
const segmenter=new Intl.Segmenter(undefined,{granularity:'grapheme'});
const graphemes=text=>[...segmenter.segment(text)];
export const field=(text='')=>({text,cursor:text.length});
const boundaries=text=>[...graphemes(text).map(g=>g.index),text.length];
const previous=f=>boundaries(f.text).filter(i=>i<f.cursor).at(-1)??0,next=f=>boundaries(f.text).find(i=>i>f.cursor)??f.text.length;
export function insert(f,s){f.text=f.text.slice(0,f.cursor)+s+f.text.slice(f.cursor);f.cursor+=s.length;}
export function backspace(f){const i=previous(f);f.text=f.text.slice(0,i)+f.text.slice(f.cursor);f.cursor=i;}
export function del(f){f.text=f.text.slice(0,f.cursor)+f.text.slice(next(f));}
export function left(f){f.cursor=previous(f);}
export function right(f){f.cursor=next(f);}
const lineStart=(t,i)=>i===0?0:t.lastIndexOf('\n',i-1)+1,lineEnd=(t,i)=>{const e=t.indexOf('\n',i);return e<0?t.length:e;};
export function home(f){f.cursor=lineStart(f.text,f.cursor);}
export function end(f){f.cursor=lineEnd(f.text,f.cursor);}
// Up and down keep the column, counted in characters, as far as the other line reaches.
const column=f=>graphemes(f.text.slice(lineStart(f.text,f.cursor),f.cursor)).length;
function toColumn(f,start,col){const line=graphemes(f.text.slice(start,lineEnd(f.text,start)));f.cursor=start+(col<line.length?line[col].index:lineEnd(f.text,start)-start);}
export function up(f){const s=lineStart(f.text,f.cursor);if(s>0)toColumn(f,lineStart(f.text,s-1),column(f));}
export function down(f){const e=lineEnd(f.text,f.cursor);if(e<f.text.length)toColumn(f,e+1,column(f));}
// Terminal cells of a grapheme: East Asian wide and emoji take two, controls and lone combining marks none.
const wide=/[\u1100-\u115f\u231a\u231b\u2329\u232a\u23e9-\u23ec\u2e80-\u303e\u3041-\u33ff\u3400-\u4dbf\u4e00-\u9fff\ua000-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6\u{1f300}-\u{1f64f}\u{1f900}-\u{1f9ff}\u{20000}-\u{3fffd}]/u;
function cells(g){
 const first=String.fromCodePoint(g.codePointAt(0));
 if(wide.test(first)||/\p{Emoji_Presentation}/u.test(first)||g.includes('\ufe0f'))return 2;
 return /[\p{Cc}\p{Mn}\p{Me}]/u.test(first)?0:1;
}
export const width=s=>graphemes(s).reduce((n,g)=>n+cells(g.segment),0);
// The longest start of s that fits in max cells.
export function clip(s,max){let out='',n=0;for(const {segment:g} of graphemes(s)){if(n+cells(g)>max)break;out+=g;n+=cells(g);}return out;}
// The rows of f in a column w cells wide, broken at each newline and before a character that does not fit, and the row and column of
// the cursor: where the next character typed goes, which is w at the end of a full row.
export function layout({text,cursor},w){
 const rows=[''];let x=0,row=0,col=0;
 for(const {segment:g,index} of graphemes(text)){
  const n=g==='\n'?0:cells(g);
  if(g!=='\n'&&x>0&&x+n>w){rows.push('');x=0;}
  if(index===cursor){row=rows.length-1;col=x;}
  if(g==='\n'){rows.push('');x=0;}else{rows[rows.length-1]+=g;x+=n;}
 }
 if(cursor===text.length){row=rows.length-1;col=x;}
 return {rows,row,col};
}
