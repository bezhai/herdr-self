// butler's config: one env-style file of its own. It holds open-lark's read-only token, never open-lark's app.env,
// which also holds the full-power token and the database URL, and the credentials of butler's own Feishu app.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readSchedule, duration } from './schedule.mjs';
import { EFFORTS } from './herdr-model.mjs';

export const defaultConfigPath = () =>
  path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'butler', 'butler.env');
const home = (p) => p.replace(/^~(?=\/|$)/, os.homedir());

export function parseEnv(text) {
  const out = {};
  for (const line of text.split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}
function httpUrl(value, key) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw Error(`${key} 不是有效地址：${value}`);
  }
  if (!/^https?:$/.test(url.protocol)) throw Error(`${key} 必须是 http(s) 地址：${value}`);
  return value.replace(/\/$/, '');
}

// The bot's app (see bot-app.mjs), when one is configured: all three keys, or none.
const BOT_KEYS = ['BUTLER_BOT_APP_ID', 'BUTLER_BOT_APP_SECRET', 'BUTLER_BOT_OWNER'];
function bot(v, file) {
  if (!BOT_KEYS.some((k) => v[k])) return undefined;
  const missing = BOT_KEYS.filter((k) => !v[k]);
  if (missing.length)
    throw Error(`配置文件 ${file} 里机器人的配置不全，缺少 ${missing.join('、')}（butler bot create 会写好它们）`);
  const domain = v.BUTLER_BOT_DOMAIN || 'feishu';
  if (!['feishu', 'lark'].includes(domain)) throw Error(`BUTLER_BOT_DOMAIN 只能是 feishu 或 lark：${domain}`);
  return { appId: v.BUTLER_BOT_APP_ID, appSecret: v.BUTLER_BOT_APP_SECRET, owner: v.BUTLER_BOT_OWNER, domain };
}
// Whether butler hands my new messages to Bridge's topics (see route-round.mjs): off, dry-run (the routing agent decides and
// butler keeps its notes, sends nothing) or on.
const ROUTING = ['off', 'dry-run', 'on'];
function routing(value) {
  if (value && !ROUTING.includes(value)) throw Error(`BUTLER_ROUTING 只能是 off、dry-run 或 on：${value}`);
  return value || 'off';
}
function effort(value) {
  if (value && !EFFORTS.includes(value))
    throw Error(
      `BUTLER_MODEL_EFFORT 是 claude 的推理强度，只能是 ${EFFORTS.slice(0, -1).join('、')} 或 ${EFFORTS.at(-1)}：${value}`,
    );
  return value || undefined;
}

export function loadConfig(file = process.env.BUTLER_CONFIG || defaultConfigPath()) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch (e) {
    if (e.code === 'ENOENT') throw Error(`配置文件不存在：${file}（格式见 butler/README.md）`);
    throw e;
  }
  if (stat.mode & 0o077)
    throw Error(
      `配置文件 ${file} 里有 open-lark 的只读 token 和机器人的密钥，权限必须是 600（现在是 ${(stat.mode & 0o777).toString(8)}）：chmod 600 ${file}`,
    );
  const v = parseEnv(fs.readFileSync(file, 'utf8'));
  // Starting work in a new group (see newchat.mjs): Bridge's address and access key (the environment of one command may
  // give them instead, for a dry run), the open-lark token that may add a bot, and Bridge's bot as open-lark knows it.
  const bridgeUrl = process.env.BUTLER_BRIDGE_URL || v.BUTLER_BRIDGE_URL,
    bridgeKey = process.env.BUTLER_BRIDGE_KEY || v.BUTLER_BRIDGE_KEY;
  return {
    file,
    token: v.BUTLER_OPEN_LARK_TOKEN || undefined,
    bot: bot(v, file),
    newChat: {
      bridgeUrl: bridgeUrl ? httpUrl(bridgeUrl, 'BUTLER_BRIDGE_URL') : undefined,
      bridgeKey: bridgeKey || undefined,
      writeToken: v.BUTLER_OPEN_LARK_WRITE_TOKEN || undefined,
      botId: v.BUTLER_BRIDGE_BOT_ID || undefined,
    },
    // Routing my new messages to topics: the mode, and butler's own bot as open-lark knows it (its messages are not news to a topic),
    // when it has one. It uses Bridge's address, key and bot of newChat.
    routing: routing(v.BUTLER_ROUTING),
    ownBotId: v.BUTLER_BOT_LARK_ID || undefined,
    bytedcli: home(v.BUTLER_BYTEDCLI || 'bytedcli'),
    schedule: readSchedule({
      days: v.BUTLER_DIGEST_DAYS || undefined,
      hours: v.BUTLER_DIGEST_HOURS || undefined,
      every: v.BUTLER_DIGEST_EVERY || undefined,
      offHoursNew: v.BUTLER_DIGEST_OFF_HOURS_NEW || undefined,
      offHoursGap: v.BUTLER_DIGEST_OFF_HOURS_GAP || undefined,
    }),
    openLarkUrl: httpUrl(v.BUTLER_OPEN_LARK_URL || 'http://127.0.0.1:8081', 'BUTLER_OPEN_LARK_URL'),
    linkBase: httpUrl(v.BUTLER_LINK_BASE || 'http://127.0.0.1:3333', 'BUTLER_LINK_BASE'),
    dataDir: path.resolve(
      home(v.BUTLER_DATA_DIR || path.join(process.env.XDG_DATA_HOME || '~/.local/share', 'butler')),
    ),
    // The processor's model: a saved herdr machine (its label), a directory there, the model claude is asked for and
    // the effort (undefined: claude's defaults) and the local herdr executable.
    modelMachine: v.BUTLER_MODEL_MACHINE || undefined,
    modelCwd: v.BUTLER_MODEL_CWD || undefined,
    // The routing agent's directory on the model machine (see requireRoutingCwd).
    routingCwd: v.BUTLER_ROUTING_CWD || undefined,
    modelName: v.BUTLER_MODEL_NAME || undefined,
    modelEffort: effort(v.BUTLER_MODEL_EFFORT),
    herdr: home(v.BUTLER_HERDR || 'herdr'),
    // How often the processor reviews the open matters and writes 关于TA; undefined: its defaults.
    reviewEveryMs: v.BUTLER_REVIEW_EVERY ? duration(v.BUTLER_REVIEW_EVERY, '整理事项的间隔') : undefined,
    profileEveryMs: v.BUTLER_PROFILE_EVERY ? duration(v.BUTLER_PROFILE_EVERY, '写「关于TA」的间隔') : undefined,
  };
}
export function requireToken(config) {
  if (!config.token) throw Error(`配置文件 ${config.file} 没有 BUTLER_OPEN_LARK_TOKEN（open-lark 的只读 token）`);
  return config.token;
}
// Bridge's address and key, which the dry run of a new group's judgment needs.
export function requireBridge(config) {
  const { bridgeUrl, bridgeKey } = config.newChat;
  if (!bridgeUrl || !bridgeKey)
    throw Error(
      `配置文件 ${config.file} 没有 BUTLER_BRIDGE_URL 和 BUTLER_BRIDGE_KEY（Bridge 控制面的地址和访问密钥；干跑时也可以放在这条命令的环境变量里）`,
    );
  return { url: bridgeUrl, key: bridgeKey };
}
// The settings for starting work in new groups: all four keys, or undefined when the open-lark token that may add a bot, its own
// key, is not set (the feature is off): routing my new messages uses Bridge's three as well. The token without all three is an
// error that names what is missing.
export function newChatSetup(config) {
  const keys = {
    BUTLER_BRIDGE_URL: 'bridgeUrl',
    BUTLER_BRIDGE_KEY: 'bridgeKey',
    BUTLER_OPEN_LARK_WRITE_TOKEN: 'writeToken',
    BUTLER_BRIDGE_BOT_ID: 'botId',
  };
  if (!config.newChat.writeToken) return undefined;
  const missing = Object.entries(keys)
    .filter(([, k]) => !config.newChat[k])
    .map(([key]) => key);
  if (missing.length) throw Error(`配置文件 ${config.file} 里「新需求群」的配置不全，缺少 ${missing.join('、')}`);
  return config.newChat;
}
// What routing my new messages to topics needs, whatever the mode: Bridge's address and key and its bot's id, and butler's own
// bot's id when there is one. Missing keys are an error that names them.
export function requireRouting(config) {
  const { bridgeUrl, bridgeKey, botId } = config.newChat;
  const missing = Object.entries({
    BUTLER_BRIDGE_URL: bridgeUrl,
    BUTLER_BRIDGE_KEY: bridgeKey,
    BUTLER_BRIDGE_BOT_ID: botId,
  })
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length)
    throw Error(
      `配置文件 ${config.file} 里「转交新消息」的配置不全，缺少 ${missing.join('、')}（Bridge 的地址和访问密钥在干跑时也可以放在这条命令的环境变量里）`,
    );
  return { bridgeUrl, bridgeKey, botId, ownBotId: config.ownBotId };
}
// The settings of routing: undefined when BUTLER_ROUTING is off, else the mode with what requireRouting finds.
export function routingSetup(config) {
  if (config.routing === 'off') return undefined;
  return { mode: config.routing, ...requireRouting(config) };
}
export function requireModel(config) {
  if (!config.modelMachine)
    throw Error(
      `配置文件 ${config.file} 没有 BUTLER_MODEL_MACHINE（herdr 里保存的模型机器的名称，见 butler/README.md）`,
    );
  return config.modelMachine;
}
// The routing agent's directory on the model machine, one of its own: Claude Code lets it read with commands such as cat
// and grep in its working directory and in the directory of that directory's session transcripts, so these must hold only
// routing sessions, never the transcripts of the other model runs (see butler/README.md, 分派 Agent).
export function requireRoutingCwd(config) {
  if (!config.routingCwd)
    throw Error(
      `配置文件 ${config.file} 没有 BUTLER_ROUTING_CWD（模型机器上分派 Agent 专用的空目录，见 butler/README.md）`,
    );
  const withoutSlash = (dir) => dir?.replace(/\/+$/, '');
  if (withoutSlash(config.routingCwd) === withoutSlash(config.modelCwd))
    throw Error('BUTLER_ROUTING_CWD 要和 BUTLER_MODEL_CWD 不同：分派 Agent 要有自己的目录（见 butler/README.md）');
  return config.routingCwd;
}
export const storeFile = (config) => path.join(config.dataDir, 'butler.db');
// Sets keys in the config file: a key already there is replaced where it is, a new one is added at the end, every
// other line stays. The file is replaced as a whole and is mode 600 from the start.
export function saveConfig(file, values) {
  const lines = fs.readFileSync(file, 'utf8').replace(/\n$/, '').split('\n'),
    done = new Set(),
    out = [];
  for (const line of lines) {
    const key = /^\s*([A-Z0-9_]+)\s*=/.exec(line)?.[1];
    if (key === undefined || !Object.hasOwn(values, key)) {
      out.push(line);
      continue;
    }
    if (!done.has(key)) {
      out.push(`${key}=${values[key]}`);
      done.add(key);
    }
  }
  for (const [key, value] of Object.entries(values)) if (!done.has(key)) out.push(`${key}=${value}`);
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, `${out.join('\n')}\n`, { mode: 0o600, flag: 'wx' });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}
