import fs from 'node:fs';
import { clientSocket, send } from './client.ts';
import { serviceName } from './services.ts';
import type { Output } from './client.ts';
import type { ServiceRequest } from './link.ts';
// bridge-call, the command line through which any agent on a machine calls a local HTTP service that some machine's Bridge client offers (see
// services.ts and ServiceCalls). Like bridge-schedule (see schedule-command.ts), it sends the request to the Bridge client of the machine it
// runs on, which passes it on to the control plane, which sends it to the client that offers the service; the token of the service stays in
// that client's config. It runs on Node alone, like the client, and prints what the service answers. Its help is complete on its own.
export const usage = `用法：
  bridge-call <服务> <方法> <路径> [JSON | @文件] [--url-query <名>=<值>]... [-H '<名>: <值>']... [-o <文件>]
  bridge-call --list

经 Bridge 调用某台机器的客户端提供的本地 HTTP 服务。服务的地址和 token 只在提供它的那台机器的客户端配置里，命令不接触；
命令只连本机的 Bridge 客户端，由客户端转给 Bridge，再转给提供这个服务的机器。服务允许哪些方法和请求头，由提供它的机器的配置决定。

参数：
  <服务>    服务名，小写字母、数字和 -，用 --list 查看有哪些。
  <方法>    GET、HEAD、POST、PUT、PATCH 或 DELETE；服务的配置不允许的方法会被拒绝。
  <路径>    相对于服务根地址的路径，以 / 开头，/ 就是根地址本身（不加结尾的 /）；可以带查询字符串，例如 /items?limit=5。不能含 .. 或 . 段（包括编码后的）、
            反斜杠、scheme，也不能以 // 开头；不能带 #。
  JSON      POST、PUT 和 PATCH 的请求体：以 { 或 [ 开头的 JSON 文本，或者 @文件 从文件读取；没有时发 {}。GET、HEAD 和 DELETE 不能带请求体。

选项：
  --url-query <名>=<值>  追加一个查询参数，名和值都会做 URL 编码；可以重复。名字里有 = 时只有第一个 = 是分隔符。
  -H, --header '<名>: <值>'  传一个请求头；服务的配置不允许的请求头会被拒绝。可以重复。
  -o <文件>             把回答的内容写到文件。回答不是文本（例如图片）时必须用它；HTTP 400 以上时不写文件，错误内容照常打印。
  --list                打印 Bridge 现在知道的服务名，一行一个。
  -h, --help            显示这段说明。
  选项后面的值原样使用，以 -- 开头也一样；也可以写成 --url-query=名=值。

输出和退出码：
  文本回答原样打印到标准输出，不加换行。HTTP 状态低于 400 退出 0；400 以上退出 1，错误内容打印到标准输出，状态码写到标准错误。
  用法错误退出 2，同时打印这段用法。Bridge 这边的失败退出 1，一行原因写在标准错误里，常见的有：
  连不上本机的 Bridge 客户端、本机的 Bridge 客户端没有连上控制面：这台机器的客户端没有运行或者没有连上 Bridge。告诉主人，不要反复重试。
  没有权限连接本机的 Bridge 客户端，或者 Operation not permitted：命令在 Agent 的沙箱里被拦住了，按所在工具的方式申请在沙箱外运行这一条命令。
  没有机器提供服务：服务名不对或者提供它的机器不在线；用 --list 核对。服务同时由多台机器提供：配置有误，告诉主人。
  不允许 <方法> 请求、不允许传请求头：服务的配置不允许，换成允许的方法，不要绕过。
  服务没有响应：告诉主人检查那台机器上的服务；确认恢复后再试。服务的回答超过 20 MB：缩小范围，或者按服务的接口分页。
`;
type Parsed = {
  service?: string;
  method?: string;
  path?: string;
  body?: string;
  query: [string, string][];
  headers: Record<string, string>;
  output?: string;
  list: boolean;
  help: boolean;
};
const usageError = (message: string) => Object.assign(Error(message), { usage: true });
const methods = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'];
// The options and the positional arguments of args: an option takes the next argument, or what follows its =, whatever it looks like.
function parse(args: string[]): Parsed {
  const out: Parsed = { query: [], headers: {}, list: false, help: false },
    positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i],
      eq = a.startsWith('--') ? a.indexOf('=') : -1,
      flag = eq > 0 ? a.slice(0, eq) : a;
    if (a === '--help' || a === '-h') {
      out.help = true;
      continue;
    }
    if (a === '--list') {
      out.list = true;
      continue;
    }
    if (['--url-query', '--header', '-H', '-o'].includes(flag)) {
      const value = eq > 0 ? a.slice(eq + 1) : args[++i];
      if (value == null) throw usageError(flag + ' 缺少值');
      if (flag === '--url-query') {
        const split = value.indexOf('=');
        if (split <= 0) throw usageError('--url-query 要写成 <名>=<值>');
        out.query.push([value.slice(0, split), value.slice(split + 1)]);
      } else if (flag === '-o') out.output = value;
      else {
        const split = value.indexOf(':'),
          name = value.slice(0, split).trim().toLowerCase();
        if (split <= 0 || !name) throw usageError("-H 要写成 '<名>: <值>'");
        out.headers[name] = value.slice(split + 1).trim();
      }
      continue;
    }
    if (a.startsWith('--') || (a.startsWith('-') && a.length > 1 && !/^-\d/.test(a)))
      throw usageError('未知的参数：' + a);
    positional.push(a);
  }
  if (out.list && (positional.length || out.output || out.query.length || Object.keys(out.headers).length))
    throw usageError('--list 不带其他参数');
  if (positional.length > 4) throw usageError('多余的参数：' + positional.slice(4).join(' '));
  const [service, method, path, body] = positional;
  return {
    ...out,
    ...(service != null && { service }),
    ...(method != null && { method }),
    ...(path != null && { path }),
    ...(body != null && { body }),
  };
}
// The request of the parsed arguments: its path without the query string, which becomes pairs ahead of the --url-query ones, and its body, read from a file for @file.
function requestOf(o: Parsed): ServiceRequest {
  if (!o.service) throw usageError('缺少服务名');
  if (!serviceName.test(o.service)) throw usageError('服务名不合法：' + o.service);
  if (!o.method) throw usageError('缺少方法');
  const method = o.method.toUpperCase();
  if (!methods.includes(method)) throw usageError('未知的方法：' + o.method);
  if (o.path == null) throw usageError('缺少路径');
  if (o.path.includes('#')) throw usageError('路径里不能带 #');
  const cut = o.path.indexOf('?'),
    path = cut < 0 ? o.path : o.path.slice(0, cut),
    query: [string, string][] = [
      ...(cut < 0 ? [] : ([...new URLSearchParams(o.path.slice(cut + 1))] as [string, string][])),
      ...o.query,
    ];
  let body: string | undefined;
  if (o.body !== undefined) {
    if (!['POST', 'PUT', 'PATCH'].includes(method)) throw usageError(method + ' 不能带请求体');
    if (/^[{[]/.test(o.body)) body = o.body;
    else if (o.body.startsWith('@')) {
      try {
        body = fs.readFileSync(o.body.slice(1), 'utf8');
      } catch (e) {
        throw usageError(`读不到请求体文件 ${o.body.slice(1)}：${e.code || e.message}`);
      }
    } else throw usageError('多余的参数：' + o.body);
  }
  return {
    service: o.service,
    method,
    path,
    ...(query.length && { query }),
    ...(body !== undefined && { body }),
    ...(Object.keys(o.headers).length && { headers: o.headers }),
  };
}
// Runs bridge-call with argv, printing to stdout and stderr; resolves to the exit code. It reaches the client at clientSocket(env).
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
    const socket = clientSocket(env);
    if (o.list) {
      const { services } = await send(socket, '/services/list', {});
      if (services.length) stdout.write(services.join('\n') + '\n');
      else stderr.write('bridge-call: 现在没有任何服务\n');
      return 0;
    }
    const request = requestOf(o),
      answer = await send(socket, '/services/call', request),
      failed = answer.status >= 400;
    const bytes = Buffer.from(answer.body, answer.encoding === 'base64' ? 'base64' : 'utf8');
    if (failed && answer.encoding === 'base64')
      throw Error(`服务回答 HTTP ${answer.status}，内容不是文本（${answer.contentType || '没有 content-type'}）`);
    if (failed) {
      stdout.write(answer.body);
      stderr.write(`bridge-call: HTTP ${answer.status}\n`);
      return 1;
    }
    if (o.output !== undefined) fs.writeFileSync(o.output, bytes);
    else if (answer.encoding === 'base64')
      throw Error(
        `回答不是文本（${answer.contentType || '没有 content-type'}，${bytes.length} 字节），用 -o <文件> 保存`,
      );
    else stdout.write(answer.body);
    return 0;
  } catch (e) {
    stderr.write(`bridge-call: ${e.message}\n${e.usage ? usage : ''}`);
    return e.usage ? 2 : 1;
  }
}
