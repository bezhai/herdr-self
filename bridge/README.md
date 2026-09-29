# Herdr Bridge

连接本机或 SSH 上的 Herdr，把飞书聊天路由到 Herdr 中的 Agent：每个飞书话题对应 Herdr 里一个 tab 中的 Agent 会话。网页提供机器、飞书应用、会话绑定和话题管理。

## 启动

需要 Node.js 24+。运行 Agent 的机器需要安装 Herdr，以及绑定所选 Agent 的命令行工具（Claude Code 或 Codex）。

Bridge（SSH 连接时为 SSH 登录用户）必须与 Herdr server 使用同一用户和相同的 `HOME`、`XDG_CONFIG_HOME`：`herdr --session <name>` 按 `$XDG_CONFIG_HOME/herdr/sessions/<name>/herdr.sock` 查找 server，未设置 `XDG_CONFIG_HOME` 时使用 `$HOME/.config/herdr/sessions/<name>/herdr.sock`。

```bash
cd bridge
npm ci
npm start
```

`npm start` 先用 Vite 构建管理台（输出到 `web/dist/`），构建失败则不会启动。只支持安装完整依赖的源码部署：使用 `npm ci`，不要加 `--omit=dev`，构建工具在开发依赖中。Bridge 目录需要可写。前端未构建时 `/` 与 `/connect` 返回 503。

打开 `http://localhost:8080`。首次启动生成 `state/access-key`，使用该文件中的访问密钥登录。状态目录包含应用凭证和会话配置，不应提交到 Git。

| 环境变量 | 默认值 | 用途 |
| --- | --- | --- |
| `PORT` | `8080` | HTTP 端口 |
| `BIND` | `0.0.0.0` | 监听地址 |
| `BRIDGE_HOSTS` | 空 | 允许访问的额外域名或 IP，逗号分隔，不含端口 |
| `BRIDGE_STATE` | `bridge/state` | 状态目录 |
| `BRIDGE_URL` | 空 | 管理台对外地址，例如 `http://host:8080`，用于机器人在飞书里回复的绑定链接。只能是 http(s) 地址，不带路径、查询参数和 `#`，末尾的 `/` 会去掉；格式不对时 Bridge 不会启动。未配置时机器人只提示到管理台完成绑定 |

默认允许 localhost、127.0.0.1 和当前主机名。通过其他地址访问时配置 `BRIDGE_HOSTS`；`BRIDGE_URL` 中的主机名也需要在允许范围内。当前管理台采用单用户密钥登录；公网部署需要 HTTPS 反向代理。

## 接入

1. **机器连接**：添加本机或 SSH 连接，选择 Herdr session。SSH 使用 Bridge 主机的配置、密钥和 known_hosts。
2. **平台连接**：点击添加飞书，在官方页面新建或选择已有应用。确认后自动保存凭证并建立长连接。新应用创建者自动加入允许名单；也支持手动填写已有应用凭证。连接成功和验证凭证后，应用名称和头像以飞书机器人为准。
3. **会话绑定**：在飞书里给机器人发一条消息，私聊直接发，群聊需要 @机器人。未绑定的聊天会收到机器人在这条消息下的回复：配置了 `BRIDGE_URL` 时是绑定链接，否则提示到管理台完成绑定。打开链接（未登录时先登录），绑定表单已带入应用和聊天，选择机器、工作目录和 Agent 类型（Claude / Codex）后保存；也可以在「会话绑定」页点击「新建绑定」，从等待绑定的聊天中选择。保存后，这条首条消息随即开启第一个话题。群聊可以选择是否仅 @机器人时触发，私聊总是触发。链接 30 分钟内有效，期间同一聊天的后续消息不会重复回复；过期后再发消息会得到新链接。等待绑定的聊天只保存在内存中，Bridge 重启后需要重新发消息。每个应用下一个聊天只能有一条绑定。
4. **话题**：聊天里的一条顶层消息开启一个话题（绑定要求 @机器人 时，这条消息需要 @机器人）。Bridge 在 Herdr 的工作区「飞书 · 绑定名称」中为话题新开一个 tab，在工作目录启动所选 Agent，把消息发给它，并在话题里回复启动结果。话题内的后续消息直接发给同一个 Agent，不需要 @机器人。Agent 首次在某个目录启动时可能停在确认界面（例如 Claude 的目录信任提示），这时 Bridge 会在话题里提示，需要到 Herdr 中处理后重发消息。

手动添加飞书应用时，需要配置机器人收发消息的权限和消息事件 `im.message.receive_v1`，通过长连接接收事件并发布应用。官方接入流程还会订阅卡片回调 `card.action.trigger`，当前未使用。

## 实现

- Node.js ES Modules 后端；管理台为 React + Vite（`web/`），构建产物为同源 JS/CSS，满足服务端 CSP（不允许内联脚本、内联样式与外部资源）。
- `@larksuite/channel` 负责应用注册、连接、消息规范化和话题内回复；各应用使用独立 Channel 和缓存。
- 连接成功和验证凭证后，Bridge 通过 `/open-apis/bot/v3/info` 读取机器人名称、open_id 和头像地址。头像只接受 https、1 MB 以内、类型为 `image/png`、`image/jpeg`、`image/gif` 或 `image/webp` 的响应（不接受 SVG，因为 SVG 可以携带脚本，而头像与控制台同源），保存在状态目录的 `avatars/` 下，由需要登录的 `/api/apps/avatar` 提供；下载失败只记录日志，保留旧头像，不影响连接。删除应用时一并删除头像。
- Bridge 只通过 Herdr CLI 工作：`agent list`、`pane list` 读取机器上的终端与 Agent；`workspace list/create`、`tab create`、`agent start`、`agent prompt` 为话题开 tab、启动 Agent 并发送消息。工作目录中的 `~/` 在目标机器上展开。
- Bridge 校验允许名单和聊天路由。未绑定聊天的待绑定记录以 128 位随机 token 标识，只保存在内存中；保存绑定时应用和聊天只取自 token 对应的记录，不接受浏览器传入。首条消息只用于绑定后开启第一个话题，不写入状态目录，也不返回浏览器。
- 消息至多发送一次：消息 ID 在调用 Herdr 之前落盘，重复到达的消息直接忽略；同一话题内的消息按顺序发送，发送失败只记录日志，不重试。
- 状态目录保存机器、应用、绑定、话题、连接日志和机器人头像。话题只保存首条消息的前 24 个字符作为标题，以及最近 50 个消息 ID 用于去重，不保存其他消息内容。
- 管理接口要求登录，校验 Host/Origin；应用 Secret 不回传浏览器。关闭或重启 Bridge 不会停止 Herdr 与其中的 Agent。

当前支持文本及不带资源的富文本消息。Bridge 在飞书里只回复自己的状态（未绑定聊天的绑定提示、启动结果、启动失败、会话已结束、Agent 等待确认），Agent 的回复不会转回飞书，需要在 Herdr 中查看。解除绑定会删除它的话题记录，但不会关闭 Herdr 中的 tab。回复转发、审批、自动关闭 tab、文件输入、流式输出和独立手机客户端尚未实现。

## 验证

```bash
npm test
```

先构建前端，再运行 `node --test test.mjs` 与 `vitest run`。

- 后端（`test.mjs`）：SSH 参数、Herdr 路径与 `~/` 展开、Herdr CLI 错误码与单次调用超时、绑定校验（工作目录、Agent 类型、每个聊天一条绑定）、授权与消息路由（已绑定聊天交给话题处理，未绑定的私聊和 @机器人的群聊申请绑定）、待绑定聊天（绑定链接、重复消息不重复回复、过期后换新 token、未配置 `BRIDGE_URL` 时的提示、首条消息不落盘）、通过链接 token 保存绑定（应用与聊天取自记录、私聊不要求 @、token 用后失效、首条消息交给话题处理）、`BRIDGE_URL` 校验、机器人名称与头像同步（https、1 MB、只接受位图类型、拒绝 SVG，失败不影响连接）、话题内回复与不重试的发送、Channel 只监听消息与连接事件、旧状态文件只保留五个集合、话题会话（使用模拟的 Herdr：新建工作区与 tab、启动参数与超时、去重与单飞、工作区重建、会话结束、启动失败与重试、停用机器、`agent_not_ready` 与 `agent_blocked`、只有开启话题的消息需要 @、重启恢复）、服务端 `/api/state` 结构（含待绑定聊天）、失效 token 的绑定请求、头像接口（内容与类型、未登录 401、没有头像 404）、删除应用时删除头像、解除绑定（使用模拟的 Herdr 命令）、`BRIDGE_URL` 格式不对时拒绝启动、应用注册生命周期、凭证隔离，以及静态资源映射（路径白名单、未构建时 503）和构建产物的 CSP 检查。
- 前端（`web/src/**/*.test.*`，jsdom）：状态派生（Agent 状态、指标、绑定状态、话题状态）、轮询与失败恢复、401 回到登录页、机器卡片的 Herdr Agent 列表、绑定列表与每个绑定下的话题、`?bind=` 绑定链接（登录前后、失效提示、清除查询参数）、「新建绑定」列出等待绑定的聊天、绑定表单（只读来源、仅群聊显示 @ 选项）、应用头像、弹窗表单与提交、注册弹窗与 `/connect` 跳转白名单、toast。

SDK 请求和 Herdr 命令在测试中模拟，不会创建飞书应用、向真实聊天发送消息或启动 Agent。原生 dialog 的键盘与焦点行为需要在浏览器中验证。

## 参考

- [飞书智能体接入](https://open.larkoffice.com/document/mcp_open_tools/integrating-agents-with-feishu/overview)
- [Channel SDK](https://github.com/larksuite/channel-sdk-node)
