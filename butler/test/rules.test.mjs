import test from 'node:test';
import assert from 'node:assert/strict';
import {categoriesOf,mentionsMe,plainText,isUnreadable,messageLink,threadRootOf} from '../rules.mjs';

const me='6900000000000000001',since=Date.parse('2026-10-22T00:00:00Z');
const view=o=>({id:'7100000000000000001',feedId:'6800000000000000001',position:'5',createdAt:'2026-10-22T08:00:00.000Z',senderId:'6900000000000000099',senderName:'同事',
 senderType:'user',isMine:false,isEdited:false,isRecalled:false,parts:[{kind:'text',text:'hi'}],textPreview:'hi',threadId:'7100000000000000001',threadMessageType:'none',threadReplyCount:0,...o});
const ctx=o=>({me,collectedSince:since,chatKind:'group',...o});

test('a group message that is not about me is stored, unless its chat is ignored; an instant chat takes it from when it became instant',()=>{
 assert.deepEqual(categoriesOf(view(),ctx()),['stored'],'a chat without a level is stored and not looked at');
 for(const level of ['daily','store'])assert.deepEqual(categoriesOf(view(),ctx({level:{level,since}})),['stored'],level);
 assert.deepEqual(categoriesOf(view(),ctx({level:{level:'ignore',since}})),[],'an ignored chat is not stored');
 assert.deepEqual(categoriesOf(view(),ctx({level:{level:'instant',since}})),['instant']);
 assert.deepEqual(categoriesOf(view(),ctx({level:{level:'instant',since:Date.parse('2026-10-22T09:00:00Z')}})),['stored'],'messages before the chat became instant are only stored');
});
test('what is about me is kept whatever the level of its chat, and never as stored',()=>{
 const atMe=view({parts:[{kind:'at',refId:me,text:'@我'}],isAtMe:true});
 for(const level of ['instant','daily','store','ignore'])assert.deepEqual(categoriesOf(atMe,ctx({level:{level,since}})),['mention',...level==='instant'?['instant']:[]],level);
 assert.deepEqual(categoriesOf(view({isMine:true}),ctx({level:{level:'ignore',since}})),['own']);
 assert.deepEqual(categoriesOf(view({parentId:'p',replyTo:{id:'p',senderId:me,senderName:'我'}}),ctx({level:{level:'ignore',since}})),['reply']);
});
test('a direct message is about me when a person sends it; a bot\'s or an agent\'s goes by the chat\'s level, which is instant until the model grades it',()=>{
 for(const level of [undefined,'instant','daily','store','ignore'])
  assert.deepEqual(categoriesOf(view(),ctx({chatKind:'direct',level:level&&{level,since}})),['dm'],`a person's, whatever the level (${level}), and dm alone`);
 for(const senderType of ['bot','agent']){
  assert.deepEqual(categoriesOf(view({senderType}),ctx({chatKind:'direct'})),['instant'],`${senderType}: a direct chat not graded yet is instant`);
  assert.deepEqual(categoriesOf(view({senderType,createdAt:'2026-10-21T08:00:00.000Z'}),ctx({chatKind:'direct'})),[],'nothing before collection started');
  assert.deepEqual(categoriesOf(view({senderType}),ctx({chatKind:'direct',level:{level:'store',since}})),['stored'],`${senderType}: graded store, only kept`);
  assert.deepEqual(categoriesOf(view({senderType}),ctx({chatKind:'direct',level:{level:'instant',since}})),['instant'],senderType);
  assert.deepEqual(categoriesOf(view({senderType}),ctx({chatKind:'direct',level:{level:'ignore',since}})),[],senderType);
 }
 assert.deepEqual(categoriesOf(view({isMine:true}),ctx({chatKind:'direct',level:{level:'instant',since}})),['dm','own']);
 assert.deepEqual(categoriesOf(view({senderType:undefined}),ctx({chatKind:'direct'})),['dm'],'a sender of unknown type counts as a person');
 assert.deepEqual(categoriesOf(view(),ctx({chatKind:'topic'})),['stored'],'a group of any kind not graded yet is only kept');
});
test('@me counts, @all alone does not even when Lark sets is_at_me for it',()=>{
 const atMe=view({parts:[{kind:'at',refId:me,text:'@我'},{kind:'text',text:' 看下'}],isAtMe:true});
 const atAll=view({parts:[{kind:'at',refId:'all',text:'@所有人'}],isAtMe:true,isAtAll:true});
 const both=view({parts:[{kind:'at',refId:'all',text:'@所有人'},{kind:'at',refId:me,text:'@我'}],isAtMe:true,isAtAll:true});
 assert.equal(mentionsMe(atMe,me),true);assert.equal(mentionsMe(atAll,me),false);assert.equal(mentionsMe(both,me),true);
 assert.equal(mentionsMe(view({isAtMe:true}),me),true,'is_at_me without an @ part (and without @all) still counts');
 assert.deepEqual(categoriesOf(atMe,ctx()),['mention']);assert.deepEqual(categoriesOf(atAll,ctx()),['stored'],'an @all alone is not about me');
 assert.deepEqual(categoriesOf(view({isMine:true,parts:[{kind:'at',refId:me,text:'@我'}]}),ctx()),['own'],'my own message is never a mention of me');
});
test('every message I send is mine to keep, in any chat',()=>{
 assert.deepEqual(categoriesOf(view({isMine:true}),ctx()),['own'],'in a group without a level');
 assert.deepEqual(categoriesOf(view({isMine:true}),ctx({chatKind:'direct'})),['dm','own']);
 assert.deepEqual(categoriesOf(view({isMine:true,threadMessageType:'reply',threadId:'root',parentId:'root',position:'-1'}),ctx({participatedSince:since})),['thread','own']);
 assert.deepEqual(categoriesOf(view({isMine:true,createdAt:'2026-10-21T08:00:00.000Z'}),ctx()),[],'nothing before collection started');
});
test('direct chats, replies to me and threads I took part in',()=>{
 assert.deepEqual(categoriesOf(view(),ctx({chatKind:'direct'})),['dm']);
 assert.deepEqual(categoriesOf(view({parentId:'p',replyTo:{id:'p',senderId:me,senderName:'我'}}),ctx()),['reply']);
 assert.deepEqual(categoriesOf(view({parentId:'p'}),ctx({parentIsMine:true})),['reply']);
 assert.deepEqual(categoriesOf(view({parentId:'p',replyTo:{id:'p',senderId:'someone',senderName:'x'}}),ctx()),['stored']);
 const reply=view({threadMessageType:'reply',threadId:'root',parentId:'root',position:'-1'});
 assert.deepEqual(categoriesOf(reply,ctx({participatedSince:since})),['thread']);
 assert.deepEqual(categoriesOf(reply,ctx({participatedSince:Date.parse('2026-10-22T09:00:00Z')})),['stored'],'replies before I joined the thread are not follow-ups');
 assert.deepEqual(categoriesOf(view({parentId:'p'}),ctx({participatedSince:since})),['stored'],'a plain quote reply is not a thread message');
 assert.deepEqual(categoriesOf(view({parts:[{kind:'at',refId:me}],createdAt:'2026-10-21T08:00:00.000Z'}),ctx({chatKind:'direct'})),[],'nothing before collection started');
 const many=categoriesOf(view({parts:[{kind:'at',refId:me}],isAtMe:true,replyTo:{id:'p',senderId:me,senderName:'我'},parentId:'p'}),ctx({chatKind:'direct'}));
 assert.deepEqual(many,['mention','dm','reply']);
});
test('thread roots and plain text',()=>{
 assert.equal(threadRootOf(view({threadMessageType:'root'})),'7100000000000000001');
 assert.equal(threadRootOf(view({threadMessageType:'reply',threadId:'7100000000000000000'})),'7100000000000000000');
 assert.equal(threadRootOf(view({threadId:'other',parentId:'other'})),undefined,'threadId alone (set on every message) does not make a thread');
 assert.equal(plainText(view({parts:[{kind:'at',refId:me,text:'@我'},{kind:'text',text:' 请看 '},{kind:'link',text:'文档',url:'https://x'},{kind:'image'}]})),'@我 请看 文档[image]');
 assert.equal(plainText(view({parts:[],textPreview:'[卡片] 标题'})),'[卡片] 标题');
 assert.equal(isUnreadable(view({isDecryptoFail:true})),true);
 assert.equal(isUnreadable(view({parts:[{kind:'text',text:'加密消息（密钥库已锁定，请在页面解锁后再读）'}]})),true);
 assert.equal(isUnreadable(view()),false);
});
test('links open the message, and a thread reply inside its thread at the root position',()=>{
 const base='http://127.0.0.1:3333';
 assert.equal(messageLink(base,{feedId:'f',id:'m',position:'12',threadRole:'none'}),'http://127.0.0.1:3333/messenger/f?message=m&position=12');
 assert.equal(messageLink(base,{feedId:'f',id:'r',position:'12',threadRole:'root'}),'http://127.0.0.1:3333/messenger/f?message=r&position=12&thread=r');
 assert.equal(messageLink(base,{feedId:'f',id:'m',position:'-1',threadRole:'reply',rootId:'r',rootPosition:'12'}),'http://127.0.0.1:3333/messenger/f?message=m&position=12&thread=r');
 assert.equal(messageLink(base,{feedId:'f',id:'m',position:'-1',threadRole:'reply',rootId:'r'}),'http://127.0.0.1:3333/messenger/f?message=m&position=-1&thread=r','unknown root position keeps the own one, as open-lark does');
});
