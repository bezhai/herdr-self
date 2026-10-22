import test from 'node:test';
import assert from 'node:assert/strict';
import {categoriesOf,mentionsMe,plainText,isUnreadable,messageLink,threadRootOf} from '../rules.mjs';

const me='6900000000000000001',since=Date.parse('2026-10-22T00:00:00Z');
const view=o=>({id:'7100000000000000001',feedId:'6800000000000000001',position:'5',createdAt:'2026-10-22T08:00:00.000Z',senderId:'6900000000000000099',senderName:'同事',
 senderType:'user',isMine:false,isEdited:false,isRecalled:false,parts:[{kind:'text',text:'hi'}],textPreview:'hi',threadId:'7100000000000000001',threadMessageType:'none',threadReplyCount:0,...o});
const ctx=o=>({me,collectedSince:since,chatKind:'group',...o});

test('a group message qualifies only through an explicit rule',()=>{
 assert.deepEqual(categoriesOf(view(),ctx()),[]);
 assert.deepEqual(categoriesOf(view(),ctx({watchSince:since})),['watched']);
 assert.deepEqual(categoriesOf(view(),ctx({watchSince:Date.parse('2026-10-22T09:00:00Z')})),[],'messages before the group was watched are not watched messages');
});
test('@me counts, @all alone does not even when Lark sets is_at_me for it',()=>{
 const atMe=view({parts:[{kind:'at',refId:me,text:'@我'},{kind:'text',text:' 看下'}],isAtMe:true});
 const atAll=view({parts:[{kind:'at',refId:'all',text:'@所有人'}],isAtMe:true,isAtAll:true});
 const both=view({parts:[{kind:'at',refId:'all',text:'@所有人'},{kind:'at',refId:me,text:'@我'}],isAtMe:true,isAtAll:true});
 assert.equal(mentionsMe(atMe,me),true);assert.equal(mentionsMe(atAll,me),false);assert.equal(mentionsMe(both,me),true);
 assert.equal(mentionsMe(view({isAtMe:true}),me),true,'is_at_me without an @ part (and without @all) still counts');
 assert.deepEqual(categoriesOf(atMe,ctx()),['mention']);assert.deepEqual(categoriesOf(atAll,ctx()),[]);
 assert.deepEqual(categoriesOf(view({isMine:true,parts:[{kind:'at',refId:me,text:'@我'}]}),ctx()),[],'my own message is never a mention of me');
});
test('direct chats, replies to me and threads I took part in',()=>{
 assert.deepEqual(categoriesOf(view(),ctx({chatKind:'direct'})),['dm']);
 assert.deepEqual(categoriesOf(view({isMine:true}),ctx({chatKind:'direct'})),['dm']);
 assert.deepEqual(categoriesOf(view({parentId:'p',replyTo:{id:'p',senderId:me,senderName:'我'}}),ctx()),['reply']);
 assert.deepEqual(categoriesOf(view({parentId:'p'}),ctx({parentIsMine:true})),['reply']);
 assert.deepEqual(categoriesOf(view({parentId:'p',replyTo:{id:'p',senderId:'someone',senderName:'x'}}),ctx()),[]);
 const reply=view({threadMessageType:'reply',threadId:'root',parentId:'root',position:'-1'});
 assert.deepEqual(categoriesOf(reply,ctx({participatedSince:since})),['thread']);
 assert.deepEqual(categoriesOf(reply,ctx({participatedSince:Date.parse('2026-10-22T09:00:00Z')})),[],'replies before I joined the thread are not follow-ups');
 assert.deepEqual(categoriesOf(view({parentId:'p'}),ctx({participatedSince:since})),[],'a plain quote reply is not a thread message');
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
