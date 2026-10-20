# Worktree Task

在当前仓库旁边新建一个 Git worktree，在 herdr 里为它打开一个 workspace，在其中启动 Claude 或 Codex，并把任务描述作为第一条 prompt 发给它。分支名默认由 Claude haiku 按任务描述生成。

插件有两个入口，背后是同一个开任务脚本 `task.mjs`：快捷键打开的弹窗表单，以及在 shell 里直接运行脚本（例如由 `wt` 函数调用）。`herdr plugin action invoke` 不能带参数，所以 shell 入口直接运行脚本，不经过 action。

## 安装

需要 Node.js 20+（插件没有 npm 依赖，不用 `npm install`）、Herdr 0.9.1+、Git 2.31+，以及 Claude Code CLI（起分支名用，选 Claude 时也用来启动 Agent）；选 Codex 时还需要 Codex CLI。

```bash
herdr plugin link /path/to/herdr/plugins/worktree-task
herdr plugin action list --plugin bezhai.worktree-task
```

`plugin link` 只登记目录、不复制文件，修改插件后不用重新 link。起名提示词、分支名校验、随机备用名、worktree 路径和仓库检查这些逻辑在仓库的 `bridge/worktree-branch.mjs` 里，和 Herdr Bridge 的 `/wt` 话题共用，插件从 `../../bridge/worktree-branch.mjs` 导入它，所以要从完整的仓库 checkout 里 link 插件，不能只复制 `plugins/worktree-task` 这一个目录。这个文件只用 Node 自带的模块，不需要在 `bridge/` 里 `npm install`。

## 快捷键

在 `~/.config/herdr/config.toml` 里把 action 绑定到一个键，然后执行 `herdr server reload-config`：

```toml
[[keys.command]]
key = "prefix+t"
type = "plugin_action"
command = "bezhai.worktree-task.start"
description = "在新 worktree 里开始任务"
```

`prefix+t` 在 herdr 的默认键位里没有被占用。

## 命令行

在仓库里的任意目录运行：

```bash
node /path/to/herdr/plugins/worktree-task/task.mjs "给登录页加验证码"
node .../task.mjs ./requirements/task-123.md "补充说明"   # 读文件，后面的参数附在末尾
cat task.md | node .../task.mjs -                         # 从标准输入读
node .../task.mjs --codex -b feat/existing "接着做"         # 已有分支，启动 Codex
node .../task.mjs -b feat/existing                          # 不给描述：Continue work on branch feat/existing
```

选项必须写在描述前面，第一个不是选项的参数开始算作描述，所以描述里可以出现 `-`。

- `-b <分支>`、`--branch <分支>`、`--branch=<分支>`：使用本地或 origin 上已有的分支，不再起名。
- `--codex`：启动 Codex，默认启动 Claude。
- `--notify`：Agent 停在启动对话框、或者任务失败时，另外发一条 herdr 通知。弹窗总是带这个选项。
- `--help`：显示用法。

描述的来源有三种：几个参数（用空格连起来）、一个文件、`-`（标准输入）。读文件或标准输入时，后面的参数以 `\n\nAdditional context: …` 附在末尾（这里是真换行；旧 `wt` 写的是字面量 `\n`）。描述只去掉末尾的空白，换行、缩进和引号都原样发给 Agent。描述上限是 128000 字节，因为 `herdr agent prompt` 把它作为一个命令行参数传递，Linux 对单个参数的上限是 128 KiB。

进度输出到标准输出，以 `[wt]` 开头；失败信息输出到标准错误。成功退出码为 0，失败为 1，用法错误为 2。

## 开任务的步骤

1. **找到仓库。** 以当前目录（弹窗里是聚焦 pane 的目录，没有时用 workspace 的目录）所在的仓库为准。从 linked worktree 里发起时，worktree 仍然从主 checkout 创建（herdr 不接受 linked worktree 作为来源），新分支基于当前 linked worktree 的 HEAD。
2. **分支名。** 给了 `-b` 就用它，先用 `git check-ref-format --branch` 检查。没给时调用 `claude -p --model haiku`，提示词和旧 `wt` 相同，取输出里第一个 `BRANCH=` 后面的内容，要求是 `feat|fix|refactor|docs|test|chore|perf|style/` 加小写 kebab-case、最长 64 个字符。调用时去掉所有 `HERDR_*` 环境变量，因为 Claude 的 herdr hook 会把状态报告给 `HERDR_PANE_ID` 指向的 pane，也就是发起任务的那个 pane。超时、出错或者输出不合格时不中断任务，改用 `worktree/<形容词>-<名词>-<4 位十六进制>` 形式的随机分支名，并在输出里说明原因。
3. **目录。** worktree 建在 `<主仓库的父目录>/<仓库名>-worktrees/<分支名把 / 换成 ->`，例如 `/src/genvi` 的 `feat/add-login` 是 `/src/genvi-worktrees/feat-add-login`。目录已经存在时报错退出，不覆盖，此时什么都还没有创建。
4. **远端分支。** 本地没有这个分支时，先 `git fetch origin` 这一个分支；origin 上有，就建立一个跟踪 `origin/<分支>` 的本地分支。fetch 失败（没有 origin、没有网络、没有这个分支）只表示没有可跟踪的分支。用 `-b` 指定的分支在本地和 origin 都找不到时报错；起名得到的分支则由 herdr 从基础提交新建。
5. **worktree 和 workspace。** `herdr worktree create --cwd <主仓库> --branch <分支> --path <目录> [--base <linked worktree 的 HEAD>] --focus`。herdr 在仓库分组下打开一个新 workspace 并切换过去。
6. **启动 Agent。** 在新 workspace 的根 pane 里执行 `herdr agent start`。Agent 名字由分支名得到（`feat/add-login` 得到 `feat-add-login`，最长 32 个字符），已经有同名 Agent 在运行时依次加上 `-2`、`-3`。默认带权限绕过参数：Claude 是 `--dangerously-skip-permissions`，Codex 是 `--dangerously-bypass-approvals-and-sandbox`。
7. **启动对话框。** 如果 Agent 启动后停在需要人处理的对话框（例如 Codex 的「Trust this folder?」），herdr 会报告 `agent_not_ready`。脚本输出 pane 编号，用 `herdr agent wait --until idle --until done` 等你处理完，不会替你按键。等待超时就报告 pane 并退出，任务描述不会发送。
8. **发送任务描述。** `herdr agent prompt <agent> <描述>`。

## 弹窗

快捷键打开一个占终端 80% 的弹窗，最上面显示当前仓库。当前目录不在 Git 仓库里时，弹窗直接显示错误，不出现表单。

| 按键 | 作用 |
| --- | --- |
| Tab / Shift-Tab | 在任务描述、已有分支、Agent 三个字段之间切换 |
| Enter | 在任务描述里换行；在分支字段跳到 Agent；在 Agent 字段提交 |
| ←、→、↑、↓、Home、End、Backspace、Delete | 在文字字段里编辑；Ctrl-A、Ctrl-E 也是行首、行尾，Ctrl-U 清空当前字段 |
| ←、→、空格 | 在 Agent 字段里切换 Claude 和 Codex |
| Ctrl-S | 在任何字段提交 |
| Esc、Ctrl-C | 取消，不做任何事 |

粘贴（包括多行文字）按原样插入当前字段；分支字段里粘贴的换行会变成空格，提交时去掉首尾空白。任务描述和分支至少要填一个。

提交后，弹窗在一个独立的进程组里运行开任务脚本，输出写到日志文件，弹窗实时显示日志内容。日志在 herdr 的插件状态目录下，默认是 `~/.local/state/herdr/plugins/bezhai.worktree-task/logs/`，只保留最近 20 个，弹窗第一行会显示本次日志的完整路径。

- 成功时弹窗自动关闭，新 workspace 已经切换到前台，Agent 已经收到任务描述。
- 失败时弹窗显示错误和已经创建的东西，按任意键关闭。
- 运行中按 Esc 只关闭弹窗，任务在后台继续。之后如果失败，或者 Agent 停在启动对话框，会收到一条 herdr 通知。通知不保证一定出现（toast 关闭、正忙、限流或者没有客户端连接时都不显示），详细信息以日志为准。

弹窗是模态的，打开时接收所有输入。所以 Agent 停在启动对话框时，要先按 Esc 关掉弹窗，再到对应的 pane 里处理；脚本会继续等待，处理完后自动发送任务描述。

## 配置

配置文件是插件配置目录下的 `config.json`，目录位置用 `herdr plugin config-dir bezhai.worktree-task` 查看（默认是 `~/.config/herdr/plugins/config/bezhai.worktree-task/`）。文件不存在时全部使用默认值；每一项都可以省略。弹窗和命令行读的是同一个文件，修改后下一次开任务即生效，不用重启 herdr。

```json
{
  "bypassPermissions": true,
  "namingTimeoutMs": 30000,
  "agentStartTimeoutMs": 60000,
  "readyTimeoutMs": 300000
}
```

| 配置项 | 默认值 | 作用 |
| --- | --- | --- |
| `bypassPermissions` | `true` | 启动 Agent 时是否带权限绕过参数。设为 `false` 时 Claude 和 Codex 都按普通模式启动 |
| `namingTimeoutMs` | `30000` | 等待 haiku 起名的时间，超时改用随机分支名 |
| `agentStartTimeoutMs` | `60000` | 传给 `herdr agent start --timeout`，等 Agent 可以接收 prompt 的时间；herdr 只接受 3000（不含）到 300000 之间的值 |
| `readyTimeoutMs` | `300000` | Agent 停在启动对话框时，等你处理的时间 |

文件不是合法 JSON、有未知的配置项或者值的类型不对时，脚本在创建任何东西之前报错退出，避免拼错的配置项被悄悄忽略。

## 失败时

每一步失败都会输出错误原因，以及到这一步为止已经创建、并且保持原样的东西；脚本不会回滚。按出错的步骤：

| 出错的步骤 | 已经存在的东西 | 处理 |
| --- | --- | --- |
| 仓库、分支名、目录已存在、配置、描述过长 | 无（输出「没有创建任何东西」） | 按错误信息修正后重试 |
| 建立跟踪分支之后的任何一步 | 跟踪 `origin/<分支>` 的本地分支 | 用 `-b <分支>` 重试会直接使用它；不需要时 `git branch -d <分支>` |
| `worktree create` 报 `worktree_open_failed` | worktree 目录（herdr 没有为它打开 workspace） | `herdr worktree open --cwd <主仓库> --path <目录>` 打开，或者 `git worktree remove <目录>` 删除 |
| 读取 Agent 列表、启动 Agent | worktree、workspace 和根 pane | 在那个 pane 里手动启动 Agent，或者 `herdr worktree remove --workspace <id>` 清理 |
| Agent 停在启动对话框直到超时 | 以上全部，加上停在对话框的 Agent | 到报告的 pane 里处理对话框，再用 `herdr agent prompt <agent> "…"` 发描述 |
| 发送任务描述 | 以上全部，Agent 已就绪 | `herdr agent prompt <agent> "…"` 重发 |

起名失败不算失败：脚本改用随机分支名继续，并在输出里说明原因。

## 测试

```bash
cd plugins/worktree-task
node --test
```

分支名的解析、校验和随机备用名、worktree 路径这些共用逻辑的单元测试在 `bridge/test.mjs` 里。测试在临时目录里建 Git 仓库，用假的 `herdr`、`claude` 和一个记录参数的 `git` 包装（`testing/` 下，内部调用真实的 git）替换 PATH 上的同名命令，并去掉当前会话的 `HERDR_*` 变量，不会连接正在运行的 herdr，也不会调用真实的 Claude。`just check` 不包含这些测试。
