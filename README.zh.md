# dsh-shell-command

[English](README.md) | 中文

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件，把 Claude Code 的 `!` 手势带到 DSH，分为两种模式：

| 命令 | 行为 |
|---|---|
| `/! <命令>` | 执行 shell 命令，分析其输出。灵感源自 Claude Code 的 `!` 前缀——在会话工作目录执行命令，并把输出交给模型即时分析 |
| `/terminal` | 弹出交互式终端窗口；关闭本身从不向模型发送任何内容——若本次会话有过输入，转录落盘后面板会跳转到「历史」Tab 并预选中这条，是否引用给模型分析由你在那里手动决定 |

**注意**：DSH 的输入触发系统只支持 `/` 和 `@` 作为触发字符，因此我们用 `/!` 而不是裸 `!` 前缀。

## 安装

需要 `dsh` CLI 与 Node `>= 22`。

```sh
# 从 npm / 仓库安装
dsh plugin --profile web add dsh-shell-command

# 本地源码（开发用 live link，改源码重启即生效）
dsh plugin --profile web add "link:/path/to/dsh-shell-command"
```

安装后重启一次 Web 界面（`dsh web`）让 host 端命令加载；它会自动出现在输入框 `/` 菜单中。

## 快速上手

### 第一次使用 `/!` 命令

在输入框输入：
```
/! df -h
```

命令立即执行，输出交给模型分析。你会看到类似的消息：

> **Shell Command Output**  
> Command: `df -h`  
> [输出内容]

模型随后分析磁盘使用情况，如发现问题会给出建议。

### 第一次使用 `/terminal` 会话

1. 在输入框输入 `/terminal`
2. 弹出浮动终端面板，有两个Tab：**会话** 和 **历史**
3. 在会话Tab尝试一些命令：
   ```
   pwd
   ls -la
   git status
   ```
4. 点击顶部的 **退出** 按钮关闭终端
5. 面板保持打开并自动跳转到 **历史** Tab
6. 刚关闭的会话已预选并展开
7. 选择后续操作：
   - 点击 **引用并分析** 将其发给模型分析
   - 点击 **直接退出，本次不分析** 跳过并关闭面板

## 命令详解

### `/! <命令>` — 单命令分析

在会话工作目录执行命令，并立即把输出交给模型分析。这是 DSH 版的 Claude Code `!` 前缀。

**何时使用：**
- 快速状态检查：`/! git status`、`/! npm test`
- 系统诊断：`/! df -h`、`/! free -h`、`/! top -bn1 | head -20`
- 文件搜索：`/! find . -name "*.log" -mtime -1`
- 一次性操作，需要立即获得 AI 洞察

**示例：**

```bash
/! git log --oneline -10
# → 模型总结近期提交，可能发现模式

/! npm run build
# → 模型分析构建输出，标记警告或错误

/! ps aux | grep node
# → 模型解释正在运行的 Node 进程
```

**技术细节：**
- 输出有界限（`maxOutputBytes`，保留尾部）并格式化用于分析
- 命令原文和生命周期记入轨迹（`command/run`/`command/done`）
- 需要活跃的模型对话（在第一条消息、模型请求之前无法使用）

### `/terminal` — 交互式终端

交互式 PTY 弹窗（持久 shell，WebSocket 实时流）。最适合：
- **探索性调试**：运行多个命令，观察行为
- **迭代测试**：修改 → 测试 → 修改 循环
- **多步骤操作**：设置 → 执行 → 验证 工作流

**工作原理：**

关闭终端**永远不会**自动向模型发送任何内容：
- 若本次会话没收到过任何输入 → 完全不留痕迹（不落盘、不进历史列表）
- 若收到过输入 → 转录落盘到 `<工作目录>/.dsh-shell-transcripts/`，面板跳转到历史Tab并预选中这条新记录

之后由你决定是否引用它进行分析（见下方历史Tab工作流程）。

#### 会话Tab特性

- **行式终端**：等宽回显 + 输入行
- **控制键**：Ctrl+C/D/Z 发送原始控制字节到 shell
- **命令历史**：方向键上下浏览已提交过的命令（纯客户端，最多 500 条）
- **限制**：不支持 Tab 补全；完整 VT100/xterm（vim、htop）计划后续版本支持

#### 历史Tab工作流程

![终端历史Tab](docs/terminal-history-tab.png)

关闭一个收到过输入的终端会话后，面板自动切换到历史Tab：

**UI元素说明：**
1. **复选框**（左侧）：选择一条或多条历史记录用于分析
2. **时间戳**：每个会话的关闭时间
3. **查看/收起按钮**（右侧）：展开预览转录内容
4. **说明文本框**（底部）：可选的自然语言上下文，帮助模型理解
5. **默认消息提示**：显示不填写说明时模型会收到的默认消息：「请帮我分别分析这些历史终端记录。」
6. **两个操作按钮**：
   - **引用并分析**：将选中的记录发送给模型立即分析
   - **直接退出，本次不分析**：关闭面板，不向模型发送任何内容

**典型工作流程：**

```
1. 关闭终端会话（点击「退出」）
2. 面板保持打开，跳转到历史Tab
3. 刚关闭的记录已预选并自动展开
4. 查看转录预览
5.（可选）选择其他历史记录进行对比
6.（可选）在说明框添加上下文：「为什么第二次运行失败了？」
7. 点击「引用并分析」→ 模型分析选中的转录
   或点击「直接退出，本次不分析」→ 面板关闭，不向模型发送任何内容
```

**高级用法：**
- **跨运行对比**：选择 2-3 个相关会话（如修复前后）并询问：「这几次尝试之间有什么变化？」
- **引导式分析**：使用说明框引导模型注意力：「重点关注内存使用模式」
- **选择性共享**：并非每个终端会话都需要分析——只引用与当前问题相关的内容

**存储：**
- 转录持久化到 `<工作目录>/.dsh-shell-transcripts/`
- 每个会话包含：`<sessionId>-<timestamp>-<counter>.log` + `.meta.json` 元数据文件
- 保留策略：每个 session ID 保留最近 10 个会话（通过 `terminalTranscriptKeep` 配置）
- 建议将 `.dsh-shell-transcripts/` 加入 `.gitignore`

## 使用场景

### 场景1：使用 `/!` 快速诊断
```
你：构建失败了，让我检查一下...
你：/! npm run build

[输出显示 TypeScript 错误]

模型：错误表明 auth.ts 第42行缺少类型导入...
```

### 场景2：使用 `/terminal` 交互式调试
```
你：/terminal
终端：$ npm test
[测试失败]
终端：$ cat test/integration.spec.js | grep -A5 "failing test"
终端：$ ls -la test/fixtures/
终端：$ echo $NODE_ENV
[发现问题：缺少 fixture 文件]
终端：[点击「退出」]

[面板跳转到历史Tab，记录已自动选中]

你：[添加说明：「这个测试为什么失败？」]
你：[点击「引用并分析」]

模型：根据转录，测试失败是因为 test/fixtures/user-data.json 文件缺失...
```

### 场景3：对比多次运行
```
[运行1：/terminal → 安装依赖 → 检查构建时间 → 退出]
[运行2：/terminal → 启用缓存后相同步骤 → 退出]
[运行3：/terminal → 不同 Node 版本相同步骤 → 退出]

[在历史Tab]
你：[勾选全部3条记录]
你：[添加说明：「哪个配置最快，为什么？」]
你：[点击「引用并分析」]

模型：对比三次构建运行：运行2因为 npm 缓存快了3倍...
```

## 使用技巧与最佳实践

- **选择合适的工具**：单命令且需要立即反馈用 `/!`；探索性工作流程且稍后决定是否分析用 `/terminal`
- **空会话不持久化**：打开 `/terminal` 但没输入任何命令，不会创建历史记录（这是设计如此，避免混乱）
- **方向键是你的朋友**：终端输入行中，↑/↓ 可回顾最近 500 条命令（客户端、会话级别）
- **说明增加上下文**：好的说明（「对比错误信息」或「关注性能指标」）帮助模型更有效地分析
- **选择性分析**：不必分析每个终端会话——只引用与当前问题相关的内容
- **历史是每个会话独立的**：每个 DSH 对话有自己的终端历史；它们不会混在一起

## 配置

通过 profile 的 `cordis.patch.yml` 配置（Web 设置页不暴露第三方插件设置）：

```yaml
- insert:
    - id: shell-command
      name: dsh-shell-command
      config:
        shell: ''            # '' → POSIX 用 /bin/bash，Windows 用 cmd.exe
        shellArgs: []        # [] → POSIX 用 -lc，Windows 用 /d /s /c
        timeoutMs: 60000     # 硬超时，到期终止整个进程树
        maxOutputBytes: 32768  # /! 命令的输出尾部保留量
        graceMs: 3000
        analysisPrompt: ''   # '' → 内置提示词；支持 {command} {cwd} {output} 占位符
        terminalEnabled: true
        terminalMaxTranscriptBytes: 1048576   # 内存转录上限（保留尾部）
        terminalTranscriptDir: '.dsh-shell-transcripts'
        terminalTranscriptKeep: 10
```

## 安全

- 在会话工作目录（`agent.session.header.cwd`）执行
- 优先走 harness 的 `ctx.subprocess` 接缝：环境已清洗（不泄漏 `DEEPSEEK_API_KEY`/`DSH_*`），进程树级 `SIGTERM → grace → SIGKILL` 终止；缺失时回退 `node:child_process`（同样清洗环境）
- `/!` 命令的每个流输出有界（`maxOutputBytes`，超限保留尾部）
- 设计上由人驱动：命令原文记入轨迹（`command/run`），无沙箱审批步骤——与你自己在终端敲命令权限一致

## 测试

```sh
node test/unit.mjs           # 纯解析/格式化测试，零依赖
node test/smoke.mjs          # 完整 apply() + handler，跑在 mock context 上
node test/smoke-terminal.mjs # 终端注册表 + hasInput 追踪 + 历史引用 RPC（mock）
```

smoke 测试需要真实解析 `@deepseek-ai/*` 依赖；在 profile 外运行时先软链一次：

```sh
mkdir -p node_modules/@deepseek-ai
ln -s "$HOME/.dsh/profiles/node_modules/@deepseek-ai/"* node_modules/@deepseek-ai/
```

## 常见问题 FAQ

**问：何时该用 `/!` 而非 `/terminal`？**  
答：单命令且需要立即 AI 分析时用 `/!`（状态检查、快速诊断）。需要运行多个命令并稍后决定是否分析时用 `/terminal`（交互式工作流程）。

**问：为什么我的终端会话没出现在历史Tab？**  
答：空会话（没收到输入）不会持久化。如果你打开了 `/terminal` 但没输入任何命令，不会创建历史记录。这是设计如此，避免混乱。

**问：历史转录存储在哪里？**  
答：在 `<工作目录>/.dsh-shell-transcripts/`，每个会话一个 `.log` 文件加一个 `.meta.json` 元数据文件。建议将此目录加入 `.gitignore`。旧记录会自动清理（默认：每个会话保留最近10条）。

**问：可以手动删除历史记录吗？**  
答：可以，直接从 `.dsh-shell-transcripts/` 删除对应的 `.log` 和 `.meta.json` 文件。历史Tab每次打开时从磁盘读取。

**问：为什么 vim/htop/ncurses 在 `/terminal` 里不能用？**  
答：当前终端是行式的（回显 + 输入行），不是完整的 VT100/xterm 模拟器。完整终端模拟（使用 xterm.js）计划后续版本支持——需要引入构建流水线。

**问：方向键命令回顾会跨会话持久化吗？**  
答：↑/↓ 历史是客户端的，关闭浏览器Tab或面板后会重置。它的作用域是当前终端窗口，不保存到磁盘。

**问：「引用并分析」和直接在对话中问命令有什么区别？**  
答：「引用并分析」会把实际的命令转录（输出、时间戳、退出码）作为结构化数据发给模型。在对话中问依赖你的描述，可能会遗漏细节。当你希望模型看到原始输出时，用引用分析。

**问：可以引用之前 DSH 对话的转录吗？**  
答：不可以。终端历史是会话级别的。每个 DSH 对话有自己的 `.dsh-shell-transcripts/` 命名空间，历史Tab只显示当前 session ID 的记录。

**问：如果输出非常长会怎样？**  
答：`/!` 和 `/terminal` 都有输出大小限制（`maxOutputBytes` / `terminalMaxTranscriptBytes`）。超限时保留**尾部**（不是头部）。这确保最近的输出始终可见。

**问：为什么 `/!` 提示「No model request exists yet」？**  
答：`/!` 需要活跃的模型对话。先向模型发送至少一条消息（开始对话），然后 `/!` 就能用了。这是为了避免 UI 渲染时序问题。

## 已知限制

- `/!` 的输出作为 plugin 来源的消息交付（在对话中可见）
- 终端模式：仅行式显示（vim/htop 需要完整 xterm 模拟，后续版本计划支持）
- API 面锁定 `@deepseek-ai/dsh` `0.1.0-rc.x`；升级 DSH 时需锁定 peer 并回归

## 未来优化方向

我们计划在后续版本中进行以下改进：

### 完整终端模拟（迁移到 xterm.js）
- **当前**：行式终端（回显 + 输入行）
- **目标**：完整 VT100/xterm 模拟，支持 vim、htop、ncurses 应用、oh-my-posh 等丰富终端 UI
- **需要**：引入构建流水线（webpack/vite）以打包 xterm.js 及其插件

### 国际化支持（i18n）
- 多语言 UI 支持（英文、中文等）
- 从用户偏好自动检测语言
- 可配置的 UI 标签

### 其他改进
- 命令输出的语法高亮
- 会话导出/导入
- 终端历史内搜索
- 自定义键盘快捷键

## 贡献

欢迎贡献！你可以：
- 🐛 [报告 bug 或提出功能请求](https://github.com/CHplus0/dsh-shell-command/issues)
- 🔧 提交 pull request
- 📖 改进文档
- 💡 分享你的使用场景和反馈

## License

MIT
