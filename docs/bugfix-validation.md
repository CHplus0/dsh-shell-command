# 功能审查与修复验收

日期：2026-10-19（Asia/Taipei）。依据：README.md、README.zh.md、
CLAUDE.md、docs/xterm-migration-plan.md。范围是当前工作区，包含此前尚未提交的
xterm 迁移和安装兼容性改动；既有改动继续保留。

## 修复内容

- 单命令执行：备用执行路径在超时/取消后终止 POSIX 进程组并升级 SIGKILL；
  Windows 路径使用 taskkill /T /F。提前取消不启动进程。恢复首次模型请求检查和
  command/run、command/done 审计；自定义提示词的变量按字面量一次替换。
- 终端关闭：自然退出在服务端保存，断线不影响保存；显式关闭等待最终输出和退出码，
  必要时强制结束。已保存的记录不会重复写入；保存失败返回错误并保留 handle 供重试。
- 加载与交互：Web 服务缺失不阻塞 /!，服务晚到时启用终端；过期的历史和预览响应
  不覆盖当前状态；流标识跨宿主重载保持唯一；WebSocket 协议/连接错误不会形成宿主未处理异常。
- 历史与文本：UTF-8 尾部截断不破坏中文或 emoji，不超过配置字节数；OSC 标题控制符
  不吞掉中间正文；按完整文件名后缀区分会话，读取和清理不会混淆前缀相同的会话 ID；
  历史引用拒绝部分失效的选择，并去重重复路径。

## 需求与证据

| 文档需求 | 对应验证 |
|---|---|
| /! 在会话目录执行，输出交模型分析 | smoke.mjs；browser.mjs 通过实际触发器、RPC 和生成客户端验证消息 |
| 首次请求前拒绝 /!，执行后记录生命周期 | smoke.mjs；browser.mjs 验证 command/run、command/done 配对与拒绝路径 |
| 超时、取消、非零退出、spawn 失败与输出上限 | smoke.mjs；regressions.mjs 的真实进程、忽略 TERM 的后代进程、提前取消、UTF-8、失败与 managed seam 合约检查 |
| 子进程环境清洗 | regressions.mjs 验证 DSH_* 不进入实际子进程；两条路径复用宿主清洗/执行能力 |
| 单命令功能不依赖终端服务成功加载 | regressions.mjs 使用真实 Cordis 验证缺失与晚到的 Web 服务、注册和卸载 |
| 一个会话复用一个 PTY，流输入不补换行 | terminal-protocol.mjs；browser.mjs 逐键输入和持久工作目录验证 |
| Tab 补全、方向键历史、中文输入与粘贴 | browser.mjs 使用真实 bash/PTY 与 xterm 的交互验证 |
| Ctrl+C/D/Z、进度覆盖、全屏程序、尺寸同步 | browser.mjs 验证真实信号、CR、独立全屏缓冲区、vim 编辑保存、stty size |
| 切换历史标签保留模拟器现场 | browser.mjs 验证模拟器对象不重建、不重复回放 |
| 空会话与自动协议响应不生成记录 | smoke-terminal.mjs、terminal-protocol.mjs、browser.mjs |
| 关闭和自然退出不触发模型分析 | host 模拟 agent 在关闭时禁止 inject/followup；浏览器验证调用次数不增加 |
| 断线后禁用输入，结束后能干净重开 | browser.mjs：断线、提前关闭、自然退出、重新打开、scope dispose、未返回的 open RPC |
| 断线期间自然退出不丢记录，结束只保存一次 | regressions.mjs；browser.mjs 的真实离线 exit 9 验证记录内容和最终退出码 |
| 最后输出排空，保存失败可重试 | regressions.mjs：延迟 PTY 输出、忽略首次结束信号、被文件阻挡的保存目录及恢复后重试 |
| 历史列表、预览、多选、说明、默认消息、显式引用 | smoke-terminal.mjs 和 browser.mjs；真实生成客户端验证旧版无 sidecar 日志、展开/收起与分析按钮 |
| 历史预览响应乱序时仍服从当前用户操作 | browser.mjs：A/B 响应倒序、收起、切换标签、过期错误、历史列表倒序响应 |
| 会话隔离、限制保留数量、同毫秒文件排序 | regressions.mjs：前缀关联的两个会话、固定时钟下 12 次保存和保留最新 10 条、旧文件名兼容 |
| 畸形输入/连接不能拖垮宿主 | terminal-protocol.mjs 的畸形 JSON/尺寸/数据；browser.mjs 的真实未掩码 WebSocket 帧 |
| 样式、主题和生成加载器可用 | browser.mjs 使用实际 lib/client.js 的两阶段加载器，验证明/暗/缺省主题、控件、CSS 安装与卸载 |
| 本地初始化、分发产物和入口完整 | setup-local.mjs 回归；setup:local --skip-install；npm pack 后解包导入服务端，核对浏览器产物与必需文件，排除转录及 node_modules |

## 验证边界

本次最终执行结果：

| 检查 | 结果 |
|---|---|
| npm run build | 通过，重新生成 lib/client.js |
| npm run setup:local -- --skip-install | 通过，运行时依赖导入及源码构建成功 |
| npm test | setup、unit、smoke、terminal smoke、protocol、requirements regressions 全部通过 |
| npm run test:browser | 使用本机 Chrome，所有必需交互与新增回归通过 |
| npm pack + 解包入口检查 | 通过；18 个分发文件，服务端可导入，客户端与已验证构建产物一致，无本地转录或 node_modules |
| git diff --check | 通过 |

实际环境为 macOS、Node v26.8.1、Chrome/Chromium 155.0.8059.82；使用临时目录中的
真实 bash、PTY、WebSocket 和 vim。DSH 服务接口使用 fixture；模型消息由测试 agent
接收，未向真实模型发请求。htop 未安装，按既有验收规则跳过可选测试。

Windows 实际运行、远端 CI 和其他 Node 版本尚未在本次本机运行中执行；Windows
终止分支已实现，但不声称完成该平台实测。既有 CI 保留 Ubuntu / Node 22、24、26。
历史仍是有界原始日志；截断后不能完整重建旧全屏画面，这是文档中保留的既有限制。
未来规划中的国际化、导出导入和历史搜索不属于当前已承诺的功能。

本次修改保留在工作区。实际 DSH Web 实例需重启并刷新页面才能加载更新后的宿主和客户端。
