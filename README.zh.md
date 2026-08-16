# dsh-shell-command

[English](README.md) | 中文

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件，为 Web 界面新增 `/shell` 斜杠命令——把 Claude Code 的 `!` 手势拆成单命令与多命令两种模式：

| 命令 | 行为 |
|---|---|
| `/shell <命令>` | 在会话工作目录执行命令，结果作为对话流节点展示，**AI 不分析** |
| `/shell --analyze <命令>` | 执行 + 展示结果，并把结果交给模型，新回合**同步分析** |
| `/terminal` | 弹出交互式终端窗口；退出时弹「同意门」：是否把转录（可加你的自然语言补充）注入给模型分析 |

**只有第一个 token** 会被当作模式开关解析，因此命令自身的参数绝不会被误读：`/shell ls -a` 执行的是 `ls -a`（display 模式），而 `/shell -a ls` 才是分析 `ls`。裸 `/shell <命令>` 走 `defaultMode`（默认 `display`）。

## 安装

需要 `dsh` CLI 与 Node `>= 22`。

```sh
# 从 npm / 仓库安装
dsh plugin --profile web add dsh-shell-command

# 本地源码（开发用 live link，改源码重启即生效）
dsh plugin --profile web add "link:/path/to/dsh-shell-command"
```

安装后重启一次 Web 界面（`dsh web`）让 host 端命令加载；它会自动出现在输入框 `/` 菜单中。

## 三种模式

- **display**（`/shell <命令>`，或 `-d`/`--display`）：仅输出。命令生命周期（`command/run`/`command/done`）写入会话轨迹，模型完全看不到。
- **analyze**（`/shell --analyze <命令>`，或 `-a`）：输出同时通过 `agent.followup` 注入为 plugin 来源的用户消息，触发新回合分析。
- **terminal**（`/terminal`）：交互式 PTY 弹窗（持久 shell，WebSocket 实时流）。退出时二选一：
  - **不注入** → 转录落盘到 `<工作目录>/.dsh-shell-transcripts/`，并 `agent.inject` 一行"指针"（不唤醒），模型下个回合可自行读取。
  - **注入** → 可选补充自然语言；转录（有界尾部）+ 你的说明通过 `agent.followup` 触发即时分析。

### 终端模式说明

- 弹窗是**行式终端**（等宽回显 + 输入行）；完整 VT100/xterm 保真（vim、htop）为后续升级项。
- 转录目录建议 gitignore：把 `.dsh-shell-transcripts/` 加进仓库忽略列表。
- `node-pty`/`ws` 或所需服务缺失时，终端模式优雅降级（单命令模式不受影响）。

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
        maxOutputBytes: 32768
        graceMs: 3000
        defaultMode: display
        analysisPrompt: ''   # '' → 内置提示词；支持 {command} {cwd} {output} 占位符
        terminalEnabled: true
        terminalMaxTranscriptBytes: 1048576   # 内存转录上限（保留尾部）
        terminalInjectMaxBytes: 32768         # 「注入」时喂给模型的字节数
        terminalTranscriptDir: '.dsh-shell-transcripts'
        terminalTranscriptKeep: 10
```

## 安全

- 在会话工作目录（`agent.session.header.cwd`）执行。
- 优先走 harness 的 `ctx.subprocess` 接缝：环境已清洗（不泄漏 `DEEPSEEK_API_KEY`/`DSH_*`），进程树级 `SIGTERM → grace → SIGKILL` 终止；缺失时回退 `node:child_process`（同样清洗环境）。
- 每个流的输出有界（`maxOutputBytes`，超限保留尾部），展示与分析用同一份截断文本。
- 设计上由人驱动：命令原文记入轨迹（`command/run`），无沙箱审批步骤——与你自己在终端敲命令权限一致。

## 测试

```sh
node test/unit.mjs           # 纯解析/格式化测试，零依赖
node test/smoke.mjs          # 完整 apply() + handler，跑在 mock context 上
node test/smoke-terminal.mjs # 终端注册表 + 注入 + 退出同意门 RPC（mock）
```

smoke 测试需要真实解析 `@deepseek-ai/*` 依赖；在 profile 外运行时先软链一次：

```sh
mkdir -p node_modules/@deepseek-ai
ln -s "$HOME/.dsh/profiles/node_modules/@deepseek-ai/"* node_modules/@deepseek-ai/
```

## 已知限制

- 流节点以纯文本渲染（无语法高亮）。
- analyze 模式的消息会以用户消息行呈现（刻意如此——输出本就该可见）。
- API 面锁定 `@deepseek-ai/dsh` `0.1.0-rc.x`；升级 DSH 时需锁定 peer 并回归。

## License

MIT
