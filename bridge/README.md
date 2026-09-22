# Herdr Bridge

连接本机或 SSH 上的 Herdr，将飞书聊天绑定到原生 Claude 会话。网页提供机器、飞书应用和会话绑定管理。

## 启动

需要 Node.js 24+。运行 Agent 的机器需要 Python 3、Herdr 和 Claude Code。

```bash
cd bridge
npm ci
npm start
```

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
2. **Claude 适配器**：在机器卡片安装适配器，再在对应 Herdr 终端运行 `~/.local/bin/herdr-bridge-claude`。首次启动需要确认 Claude 的 development channel 提示。已有普通 Claude 进程需要通过此命令重新启动才能接入。
3. **平台连接**：点击添加飞书，在官方页面新建或选择已有应用。确认后自动保存凭证并建立长连接。新应用创建者自动加入允许名单；也支持手动填写已有应用凭证。
4. **会话绑定**：选择应用、机器、已接入会话，填写飞书 `chat_id`，按需指定话题根消息 ID。群聊默认需要 @机器人。当前聊天 ID 需要手动填写。

手动添加飞书应用时，需要配置机器人消息权限、消息事件 `im.message.receive_v1` 和卡片回调 `card.action.trigger`，通过长连接接收事件并发布应用。

## 实现

- Node.js ES Modules 后端，HTML/CSS/JavaScript 管理页面。
- `@larksuite/channel` 负责应用注册、连接、消息规范化、卡片回调和消息发送；各应用使用独立 Channel 和缓存。
- Python 适配器通过 Claude MCP Channel、hooks 和 permission relay 收发消息、处理审批。
- Bridge 校验允许名单、聊天路由和原生会话身份，持久化消息去重与投递状态。投递结果未知时不自动重发。
- 管理接口要求登录，校验 Host/Origin；应用 Secret 不回传浏览器。关闭或重启 Bridge 不会停止 Herdr/Claude。

当前支持文本及不带资源的富文本输入、分段回复和审批卡片。Codex、文件输入、COT、逐字流式输出和独立手机客户端尚未实现。真实飞书聊天与原生会话绑定后的完整收发及审批仍需联调。

## 验证

```bash
npm test
```

覆盖 SSH 参数、原生会话身份、授权与消息路由、应用注册生命周期、凭证隔离、持久化去重、SDK 分段发送和卡片回调，以及 Python MCP 启动。SDK 请求在测试中模拟，不会创建飞书应用或向真实聊天发送消息。

## 参考

- [飞书智能体接入](https://open.larkoffice.com/document/mcp_open_tools/integrating-agents-with-feishu/overview)
- [Channel SDK](https://github.com/larksuite/channel-sdk-node)
