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

默认允许 localhost、127.0.0.1 和当前主机名。通过其他地址访问时配置 `BRIDGE_HOSTS`。当前管理台采用单用户密钥登录；公网部署需要 HTTPS 反向代理。

## 接入

1. **机器连接**：添加本机或 SSH 连接，选择 Herdr session。SSH 使用 Bridge 主机的配置、密钥和 known_hosts。
2. **平台连接**：点击添加飞书，在官方页面新建或选择已有应用。确认后自动保存凭证并建立长连接。新应用创建者自动加入允许名单；也支持手动填写已有应用凭证。
3. **会话绑定**：选择应用和机器，填写飞书 `chat_id`、工作目录和 Agent 类型（Claude / Codex）。每个应用下一个聊天只能有一条绑定。当前聊天 ID 需要手动填写。
4. **话题**：聊天里的一条顶层消息开启一个话题（绑定要求 @机器人 时，这条消息需要 @机器人）。Bridge 在 Herdr 的工作区「飞书 · 绑定名称」中为话题新开一个 tab，在工作目录启动所选 Agent，把消息发给它，并在话题里回复启动结果。话题内的后续消息直接发给同一个 Agent，不需要 @机器人。Agent 首次在某个目录启动时可能停在确认界面（例如 Claude 的目录信任提示），这时 Bridge 会在话题里提示，需要到 Herdr 中处理后重发消息。

手动添加飞书应用时，需要配置机器人收发消息的权限和消息事件 `im.message.receive_v1`，通过长连接接收事件并发布应用。官方接入流程还会订阅卡片回调 `card.action.trigger`，当前未使用。

## 实现

- Node.js ES Modules 后端；管理台为 React + Vite（`web/`），构建产物为同源 JS/CSS，满足服务端 CSP（不允许内联脚本、内联样式与外部资源）。
- `@larksuite/channel` 负责应用注册、连接、消息规范化和话题内回复；各应用使用独立 Channel 和缓存。
- Bridge 只通过 Herdr CLI 工作：`agent list`、`pane list` 读取机器上的终端与 Agent；`workspace list/create`、`tab create`、`agent start`、`agent prompt` 为话题开 tab、启动 Agent 并发送消息。工作目录中的 `~/` 在目标机器上展开。
- Bridge 校验允许名单和聊天路由。消息至多发送一次：消息 ID 在调用 Herdr 之前落盘，重复到达的消息直接忽略；同一话题内的消息按顺序发送，发送失败只记录日志，不重试。
- 状态目录保存机器、应用、绑定、话题和连接日志。话题只保存首条消息的前 24 个字符作为标题，以及最近 50 个消息 ID 用于去重，不保存其他消息内容。
- 管理接口要求登录，校验 Host/Origin；应用 Secret 不回传浏览器。关闭或重启 Bridge 不会停止 Herdr 与其中的 Agent。

当前支持文本及不带资源的富文本消息。Bridge 在话题里只回复自己的状态（启动结果、启动失败、会话已结束、Agent 等待确认），Agent 的回复不会转回飞书，需要在 Herdr 中查看。解除绑定会删除它的话题记录，但不会关闭 Herdr 中的 tab。回复转发、审批、自动关闭 tab、文件输入、流式输出和独立手机客户端尚未实现。

## 验证

```bash
npm test
```

先构建前端，再运行 `node --test test.mjs` 与 `vitest run`。

- 后端（`test.mjs`）：SSH 参数、Herdr 路径与 `~/` 展开、Herdr CLI 错误码与单次调用超时、绑定校验（工作目录、Agent 类型、每个聊天一条绑定）、授权与消息路由、话题内回复与不重试的发送、Channel 只监听消息与连接事件、旧状态文件只保留五个集合、话题会话（使用模拟的 Herdr：新建工作区与 tab、启动参数与超时、去重与单飞、工作区重建、会话结束、启动失败与重试、停用机器、`agent_not_ready` 与 `agent_blocked`、只有开启话题的消息需要 @、重启恢复）、服务端绑定保存、`/api/state` 结构与解除绑定（使用模拟的 Herdr 命令）、应用注册生命周期、凭证隔离，以及静态资源映射（路径白名单、未构建时 503）和构建产物的 CSP 检查。
- 前端（`web/src/**/*.test.*`，jsdom）：状态派生（Agent 状态、指标、绑定状态、话题状态）、轮询与失败恢复、401 回到登录页、机器卡片的 Herdr Agent 列表、绑定列表与每个绑定下的话题、弹窗表单与提交、注册弹窗与 `/connect` 跳转白名单、toast。

SDK 请求和 Herdr 命令在测试中模拟，不会创建飞书应用、向真实聊天发送消息或启动 Agent。原生 dialog 的键盘与焦点行为需要在浏览器中验证。

## 参考

- [飞书智能体接入](https://open.larkoffice.com/document/mcp_open_tools/integrating-agents-with-feishu/overview)
- [Channel SDK](https://github.com/larksuite/channel-sdk-node)
