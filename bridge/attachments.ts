// The images and files of a Feishu message that Bridge hands to an agent (see Topics.attach): which resources of the message count, how
// the file of each is named, and how the prompt names them. The SDK leaves markup in the content of a message where a resource was:
// ![image](<key>) for an image of rich text or an image message, <file key="<key>" name="<name>"/> for a file message or a file of rich text,
// and <file key="<key>"/> for a video of rich text, which Feishu serves as a file.
const markup=/!\[.*?\]\(([^)]+)\)|<file key="([^"]+)"(?: name="[^"]*")?\/>/g;
// The most that Bridge downloads of an image and of a file, in bytes.
export const limits={image:10*1024*1024,file:30*1024*1024};
const kinds={image:'图片',file:'文件'};
// What a person calls attachment x, such as 图片 2.
export const label=x=>`${kinds[x.type]} ${x.n}`;
// Why attachment x of a message did not reach the agent, from the error of its download or write.
export const reason=(x,stage,e)=>e?.code==='too_large'?`超过 ${limits[x.type]/1024/1024} MB`:stage+'失败';
// The images and files of message msg in their order there, as {type, fileKey, fileName?, index, n}: index counts all of them from 1,
// n those of the same kind.
export function attachmentsOf(msg){
 const count={image:0,file:0};
 return (msg.resources||[]).filter(r=>kinds[r.type]).map((r,i)=>({type:r.type,fileKey:r.fileKey,...r.fileName&&{fileName:r.fileName},index:i+1,n:++count[r.type]}));
}
// Extensions by content type; an image without one of these is taken for a JPEG, a file for binary data.
const extensions={'image/png':'png','image/jpeg':'jpg','image/gif':'gif','image/webp':'webp','image/bmp':'bmp','image/tiff':'tiff','image/heic':'heic','image/heif':'heif','image/avif':'avif','image/svg+xml':'svg',
 'application/pdf':'pdf','application/zip':'zip','application/json':'json','text/plain':'txt','text/markdown':'md','text/csv':'csv','text/html':'html','video/mp4':'mp4','video/quicktime':'mov','audio/mpeg':'mp3'};
const defaults={image:'jpg',file:'bin'};
// The file name of attachment x of message messageId, whose download had content type type: <message id>-<index>.<extension>, only
// letters, digits, _ and - besides the dot. A file keeps the extension of its own name when that has one of letters and digits.
export function fileName(messageId,x,type){
 const own=x.type==='file'&&/\.([A-Za-z0-9]{1,16})$/.exec(x.fileName||'')?.[1].toLowerCase();
 return `${String(messageId).replace(/[^A-Za-z0-9_-]/g,'_')}-${x.index}.${own||extensions[type]||defaults[x.type]}`;
}
// The name of file x as the prompt shows it: control characters, such as line breaks, become spaces.
const shown=x=>[...(x.fileName||'').replace(/[\u0000-\u001f\u007f]+/g,' ').trim()].slice(0,100).join('')||'未命名文件';
// How the prompt names attachment x: [图片 N：<absolute path>] or [文件 N：<name>，<absolute path>] once written (x.path), else
// [图片 N：下载失败]. Claude Code takes a pasted piece of text that ends in an image extension and names an existing file for an image it
// attaches, and it splits pasted text on line breaks and before a / that follows a space. Its attachment races Herdr's Enter after the
// paste, so a path must never end such a piece: here a full-width colon or comma comes before the path and ] after it, and the agent reads
// the file itself.
const placeholder=x=>!x.path?`[${label(x)}：下载失败]`:x.type==='image'?`[${label(x)}：${x.path}]`:`[${label(x)}：${shown(x)}，${x.path}]`;
// The prompt of message msg: its content with each attachment of list (see attachmentsOf) named where its markup was; one whose markup is
// missing is named on a line of its own at the end.
export function promptOf(msg,list){
 const left=[...list];
 const text=!left.length?msg.content:msg.content.replace(markup,(m,image,file)=>{
  const i=left.findIndex(x=>x.fileKey===(image??file)&&x.type===(image!=null?'image':'file'));
  return i<0?m:placeholder(left.splice(i,1)[0]);
 });
 return [text.trim(),...left.map(placeholder)].filter(Boolean).join('\n');
}
// The text of content, the content of a message, with the markup of its attachments as spaces.
export const withoutAttachments=content=>content.replace(markup,' ');
// The title of a topic that message msg opens: the first 24 characters of its content with whitespace collapsed and the markup of its
// attachments left out; without any text, the kind of its first attachment.
export function titleOf(msg){
 const list=attachmentsOf(msg),text=(list.length?withoutAttachments(msg.content):msg.content).replace(/\s+/g,' ').trim();
 return [...text].slice(0,24).join('')||(list.length?kinds[list[0].type]:'');
}
