import fs from 'node:fs';
import path from 'node:path';
import { clientSocket, send } from './client.ts';
import { sourceLine, oversized } from './outbound-cards.ts';
import type { Output } from './client.ts';
import type { MessageOps, MessageRequest } from './messages.ts';
// bridge-message, the command line through which the agent of a Feishu topic brings a Feishu message into its topic and drafts messages
// that the owner sends as themselves after a click on the draft's card, or takes back such a draft (see Messages). Like bridge-schedule (see schedule-command.ts), it
// sends each request to the Bridge client of the machine it runs on, which passes it on to the control plane, with the agent's pane
// (HERDR_PANE_ID) and Herdr session (HERDR_SESSION); it runs on Node alone, like the client, and prints text for the agent, or with --json
// Bridge's answer. Its help is complete on its own: the skill that tells agents when to use it leaves the details of the command to it.
export const usage = `用法：
  bridge-message attach <消息 ID>
  bridge-message reply <消息 ID> --text <正文> [--mention <用户 ID>=<名字>]... [--image <路径>]... [--file <路径>]... [--doc-access view|edit]
  bridge-message send <聊天 ID> --text <正文> [--mention <用户 ID>=<名字>]... [--image <路径>]... [--file <路径>]... [--doc-access view|edit]
  bridge-message withdraw <草稿 ID>

由 Bridge 开的飞书话题里的 Agent 运行，把一条飞书消息放进这个话题作为来源，起草以主人身份发出的飞书消息，或者撤回还在等主人
确认的草稿。命令只连本机的 Bridge 客户端，由客户端转给 Bridge。消息 ID 和聊天 ID 都是 open-lark 的 ID，不是机器人开放平台的 om_…、oc_… ID；用 butler
查消息和聊天，具体看 butler --help。

操作：
  attach  读取消息，把发送人、聊天、时间、正文和原消息链接放进这个话题的来源卡片。重复 attach 同一条消息不会再发一张卡片。
  reply   起草一条引用回复。<消息 ID> 必须是已经 attach 到本话题的来源；回复发到那条来源所在的聊天，正文里引用的就是这条消息。
          来源是话题（thread）里的一条回复时，回复也发在话题里，卡片上写「发在话题里」；话题的第一条消息和普通消息照常引用回复。
  send    起草一条发到 <聊天 ID> 的新消息。聊天名和私聊或群聊都由 open-lark 读出，不采用 Agent 自己填写的名称。
  reply 和 send 只发确认卡片，不直接发飞书消息。主人点「发送」后才会发出；可以点「修改」改正文，或者点「不发」。
  命令输出「已发出确认卡片」和草稿 ID（前 8 位），不等于消息已经发出，也不要请主人在对话里回复「确认」来代替点卡片。
  withdraw 撤回本话题里还在等主人确认的草稿，<草稿 ID> 是 reply 或 send 输出的 ID，写开头几位也行，只要不和别的草稿重复。
          撤回后卡片写「Agent 已撤回」，不再有按钮。草稿不需要了（内容过时、换了说法、主人说不用发）就自己撤回，不要请主人点「不发」。

选项：
  --text <正文>         reply 和 send 必填。去掉首尾空白后不能为空；每个 --mention 的 <名字> 都要在正文里写成 @<名字>。
                        多行正文用 --text "$(cat <<'EOF'
                        …
                        EOF
                        )" 传。正文长到确认卡片放不下时 Bridge 会拒绝，缩短后重新提交。
  --mention <ID>=<名字>  @一个人；reply 和 send 可以重复给出，每个 mention 一次。<ID> 是 open-lark 的用户 ID，<名字> 是正文里
                        @ 后面显示的名字，例如 --mention u_123=陈帆，正文里写 @陈帆。名字里有 = 时只有第一个 = 是分隔符。
  --image <路径>         reply 和 send 可以重复给出：正文之后把这张图片单独发成一条消息。PNG、JPEG、GIF、WebP 或 BMP，最大 7.5 MB。
  --file <路径>          reply 和 send 可以重复给出：正文之后把这个文件单独发成一条消息，最大 20 MB。图片和文件按命令行里的先后
                        顺序发出，每份草稿加起来最大 50 MB；起草时在这台机器上读取，卡片列出每个的名字和大小，主人点一次「发送」
                        全部发出。回复的附件和正文发在同一个地方：引用同一条消息，或者发在同一个话题里。
  --doc-access view|edit 正文发出后，给这个聊天开放正文里链接的文档的查看（view）或编辑（edit）权限，用在文档还没有共享给对方时。
                        只开放 open-lark 在发出的消息里认出的文档；开放失败不影响已经发出的消息，卡片上写明哪些没有开放和原因。
  --json                输出 Bridge 返回的 JSON，而不是给 Agent 读的文字。
  --pane <pane>         Agent 所在的 Herdr pane，默认取 HERDR_PANE_ID。
  --session <名称>      Agent 所在的 Herdr session，默认取 HERDR_SESSION，都没有时是 default。
  -h, --help            显示这段说明。
  选项可以写成 --text '正文' 或 --text='正文'；选项后面的值原样使用，以 -- 开头也一样。

退出码：0 成功；1 Bridge 拒绝了请求或者连不上，原因在标准错误里；2 用法错误，同时打印这段用法。

出错时：
  连不上本机的 Bridge 客户端、本机的 Bridge 客户端没有连上控制面：这台机器的客户端没有运行或者没有连上 Bridge。告诉主人，不要反复重试。
  没有权限连接本机的 Bridge 客户端，或者 Operation not permitted：命令在 Agent 的沙箱里被拦住了，按所在工具的方式申请在沙箱外运行这一条命令。
  这个 pane 里的 Agent 不属于任何进行中的飞书话题：不是在 Bridge 的飞书话题里运行的。告诉主人，不要换 pane 或 session 绕过。
  这条消息不在本话题的来源里，先用 attach 放进来：先 attach 这条消息，再用它返回的来源做 reply；不要直接猜来源。
  正文去掉首尾空白后不能为空：补上真正要发的正文。正文里没有 @<名字>：在正文里按 --mention 的名字写出 @<名字>，或者去掉这个 mention。
  正文太长，确认卡片放不下：缩短正文后重新提交。确认卡片没有发出去：稍后重试，不要把它当成已经起草或已经发送。
  本话题没有 ID 以 … 开头的草稿：核对 reply 或 send 输出的草稿 ID；只能撤回这个话题里起草的草稿。有多个草稿的 ID 以 … 开头：写完整的 ID。
  这份草稿正在发送，不能撤回；这份草稿已经发出，不能撤回：消息已经或正在以主人身份发出，告诉主人。
  主人点过「发送」但没有发出去，不能撤回：由主人在卡片上重试或者点「不发」。这份草稿已经不发了，不用撤回：什么都不用做。
  主人正在修改这份草稿，不能撤回：等主人改完发送或者取消修改，不要反复重试。
  读不到 <路径>、<路径> 不是文件：核对路径。超过每个附件 20 MB 的上限、附件加起来超过每份草稿 50 MB 的上限：压缩、拆开，或者改发文档链接。
  图片 … 超过 7.5 MB、… 不是 PNG、JPEG、GIF、WebP 或 BMP 图片：改用 --file 发送。
  正文里没有链接，没有可以开放权限的文档：在正文里写上文档链接，或者去掉 --doc-access。
  Bridge 没有配置 open-lark 所在的机器：告诉主人需要在控制面设置 BRIDGE_OPEN_LARK_MACHINE，Agent 不能自己绕过。
  <机器名> 的 Bridge 客户端不在线：告诉主人检查那台机器的客户端。<机器名> 的 Bridge 客户端没有配置 open-lark：告诉主人检查那台机器的 client.json。
  open-lark 没有响应：告诉主人检查 open-lark；确认恢复后再试。open-lark 拒绝了这次请求或发送：按它给的说明处理，不要反复重试。
  消息或聊天不存在、当前账号不在聊天里等 open-lark 的拒绝：用 butler 重新核对 ID 和当前账号可见的消息，不要换 ID 猜测。
  其他拒绝：按 Bridge 输出的原因改正后再试；原因保持不变时不要反复提交。
`;
type Op = keyof MessageOps;
// An --image or --file as given: its kind and its path on this machine.
type Given = { kind: 'image' | 'file'; path: string };
type Parsed = Omit<MessageRequest, 'attachments' | 'docAccess'> & {
  op?: string;
  id?: string;
  json: boolean;
  help?: boolean;
  files?: Given[];
  docAccess?: string;
};
const ops: Op[] = ['attach', 'reply', 'send', 'withdraw'];
// The start of a draft's id that the command prints and withdraw accepts, as bridge-schedule shortens the ids of schedules.
const short = (id: string) => id.slice(0, 8);
// Whether v is an operation. The command loads only its own modules and the client's, so it does without oneOf of core.ts.
const isOp = (v: unknown): v is Op => ops.includes(v as Op);
const usageError = (message: string) => Object.assign(Error(message), { usage: true });
// The operation, id and options of args: an option takes the next argument, or what follows its =, whatever it looks like. A mention splits
// at its first = so that a person's displayed name may itself contain one. Images and files keep the order in which they are given.
function parse(args: string[]): Parsed {
  const out: Parsed = { json: false },
    positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i],
      eq = a.startsWith('--') ? a.indexOf('=') : -1,
      flag = eq > 0 ? a.slice(0, eq) : a;
    if (a === '--json') {
      out.json = true;
      continue;
    }
    if (a === '--help' || a === '-h') {
      out.help = true;
      continue;
    }
    if (['--text', '--pane', '--session', '--mention', '--image', '--file', '--doc-access'].includes(flag)) {
      const value = eq > 0 ? a.slice(eq + 1) : args[++i];
      if (value == null) throw usageError(flag + ' 缺少值');
      if (flag === '--image' || flag === '--file')
        (out.files ??= []).push({ kind: flag === '--image' ? 'image' : 'file', path: value });
      else if (flag === '--doc-access') out.docAccess = value;
      else if (flag === '--mention') {
        const split = value.indexOf('=');
        if (split <= 0 || split === value.length - 1) throw usageError('--mention 要写成 <用户 ID>=<名字>');
        (out.mentions ??= []).push({ id: value.slice(0, split), name: value.slice(split + 1) });
      } else out[flag.slice(2) as 'text' | 'pane' | 'session'] = value;
      continue;
    }
    if (a.startsWith('--')) throw usageError('未知的参数：' + a);
    positional.push(a);
  }
  if (positional.length > 2) throw usageError('多余的参数：' + positional.slice(2).join(' '));
  const [op, id] = positional;
  return { ...(op != null && { op }), ...(id != null && { id }), ...out };
}
// The images and files as Bridge takes them: each read on this machine, named by its file name, as base64. Sizes are checked before anything
// is read, with the limits that Bridge checks again.
function attachments(files: Given[]) {
  const found = files.map((f) => {
    let stat;
    try {
      stat = fs.statSync(f.path);
    } catch (e) {
      throw Error(`读不到 ${f.path}：${e.code || e.message}`);
    }
    if (!stat.isFile()) throw Error(`${f.path} 不是文件`);
    return { ...f, name: path.basename(f.path), size: stat.size };
  });
  const refused = oversized(found);
  if (refused) throw Error(refused);
  return found.map((f) => {
    let data;
    try {
      data = fs.readFileSync(f.path).toString('base64');
    } catch (e) {
      throw Error(`读不到 ${f.path}：${e.code || e.message}`);
    }
    return { kind: f.kind, name: f.name, data };
  });
}
// Runs bridge-message with argv, printing to stdout and stderr; resolves to the exit code. It reaches the client at clientSocket(env).
export async function main(
  argv: string[],
  {
    env = process.env,
    stdout = process.stdout,
    stderr = process.stderr,
  }: { env?: NodeJS.ProcessEnv; stdout?: Output; stderr?: Output } = {},
): Promise<number> {
  try {
    const o = parse(argv);
    if (o.help) {
      stdout.write(usage);
      return 0;
    }
    if (!isOp(o.op)) throw usageError(o.op ? '未知的操作：' + o.op : '缺少操作');
    const op = o.op,
      { json, help, id, pane: requestedPane, session: requestedSession, ...fields } = o;
    if (!id) throw usageError(op === 'send' ? '缺少聊天 ID' : op === 'withdraw' ? '缺少草稿 ID' : '缺少消息 ID');
    const drafts = op === 'reply' || op === 'send';
    if (!drafts && fields.text !== undefined) throw usageError('--text 只用于 reply 和 send');
    if (!drafts && fields.mentions !== undefined) throw usageError('--mention 只用于 reply 和 send');
    if (!drafts && fields.files?.some((f) => f.kind === 'image')) throw usageError('--image 只用于 reply 和 send');
    if (!drafts && fields.files !== undefined) throw usageError('--file 只用于 reply 和 send');
    if (!drafts && fields.docAccess !== undefined) throw usageError('--doc-access 只用于 reply 和 send');
    if (fields.docAccess !== undefined && fields.docAccess !== 'view' && fields.docAccess !== 'edit')
      throw usageError('--doc-access 只能是 view 或 edit');
    if (drafts && fields.text === undefined) throw usageError(op + ' 需要 --text');
    const pane = requestedPane ?? env.HERDR_PANE_ID,
      session = requestedSession ?? env.HERDR_SESSION;
    const target = op === 'send' ? { chatId: id } : op === 'withdraw' ? { draftId: id } : { messageId: id };
    const { docAccess } = fields,
      carried = {
        ...(fields.files && { attachments: attachments(fields.files) }),
        ...(docAccess && { docAccess: docAccess as 'view' | 'edit' }),
      };
    const body: MessageRequest = {
      ...target,
      ...(drafts && { text: fields.text, mentions: fields.mentions ?? [], ...carried }),
      ...(pane && { pane }),
      ...(session && { session }),
    };
    const r = await send(clientSocket(env), `/messages/${op}`, body);
    const text =
      'input' in r
        ? `已放进话题：${sourceLine(r.input.body, Date.now())}`
        : op === 'withdraw'
          ? `已撤回草稿 ${short(r.delivery.id)}，卡片上写着「Agent 已撤回」`
          : `已发出确认卡片，草稿 ID ${short(r.delivery.id)}，主人点「发送」后才会发出`;
    stdout.write((json ? JSON.stringify(r, null, 2) : text) + '\n');
    return 0;
  } catch (e) {
    stderr.write(`bridge-message: ${e.message}\n${e.usage ? usage : ''}`);
    return e.usage ? 2 : 1;
  }
}
