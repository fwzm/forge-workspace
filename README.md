[English](README.en.md) | **简体中文**

# FORGE — 自主软件工程工作台

本地零依赖的多 Agent 软件工程工作台模拟器：Node.js 后端 + 原生 HTML/CSS/JS 前端（无框架、无任何 npm 依赖）。可作为 **Windows 桌面应用**（Edge/Chrome 应用模式窗口）或普通本地 Web 服务器运行——并且能够**编排真实 agent CLI**（Codex、Claude Code）执行全自动流水线，仅在合并处保留人工门。

## 真实 Agent 编排（补丁模式）

编排器通过模拟 Agent 所使用的同一套任务 DAG 驱动你已安装的 agent CLI：

```
issue ─▶ 外部实现者（codex/claude）─▶ 内部 QA + 安全引擎
      ─▶ 外部评审 ─▶ CI（lint/unit/integration/security/build）
      ─▶ PR（已批准 + 全绿）─▶ ⏸ 人工合并门（默认）或自动合并
```

安全模型：

- **补丁模式** —— agent 永远不直接碰你的真实文件或虚拟仓库。整个工作区被导出到隔离的临时目录（`%TEMP%\forge-<agent>-…`）；FORGE 对结果做 diff 回收，只把该变更集应用回去，再由 CI 引擎做唯一仲裁。
- **人工合并门** —— 流水线停在「PR 已批准 + CI 全绿」，直到你点击合并（可在设置中开启 `autoMergeExternal` 跳过；不建议）。
- **熔断器** —— 外部 agent 连续失败 3 次会自动关闭调度器并写入审计记录，而不是无限循环。
- **工具噪音过滤** —— 变更集收集忽略点前缀目录（`.git`、`.mimosa`、`.claude`……），跟随 agent 会话的机器钩子无法把元数据混进提交。
- agent 空产出直接判任务失败（不允许静默空转），每一步都进入审计日志。

内置 **Codex CLI**（`codex exec`，stdin 提示词）、**Claude Code**（`claude -p --permission-mode acceptEdits`）、**ZCode**（无头 `zcode.cjs --prompt --cwd`，标准安装路径自动发现或 `FORGE_ZCODE_CJS` 指定）与 **DeepSeek Harness**（其官方自动化 **ACP** 服务器，`dsh --profile acp`，stdio 上的 JSON-RPC + 权限自动放行；`FORGE_DSH_BIN` 覆盖）适配器，均可在 设置 → *外部智能体 中探测。新增其他 CLI 只需在 `server/orchestration/adapters.js` 里加一个对象。

## 运行 — Windows 桌面应用

双击 **`desktop\Start-FORGE.vbs`**（或运行 `desktop\Install-Shortcut.ps1` 创建的桌面快捷方式）。它会在 `%LOCALAPPDATA%\FORGE` 下启动工作台服务器、打开一个无浏览器外壳的应用窗口，并在你关闭该窗口时自动清理。需要 PATH 上有 Node.js 以及 Microsoft Edge（Windows 10/11 预装）或 Google Chrome。

```
powershell -NoProfile -ExecutionPolicy Bypass -File desktop\Install-Shortcut.ps1   # 创建带图标的桌面快捷方式
node desktop\make-icon.js                                                          # 重新生成 desktop\forge.ico
```

## 运行 — 本地 Web 服务器

```bash
node server/index.js          # http://127.0.0.1:7788（环境变量：FORGE_PORT、FORGE_DATA_DIR）
```

打开界面后点击 **重置并种子演示**，再点 **执行全部步骤**，即可观看完整场景：issue → planner 拆 DAG → 带缺陷的实现 → QA 失败 → 安全扫描失败 → 修复 → 评审要求修改 → 再修复 → CI 全绿 → 批准 → 合并。

## 测试

```bash
npm test                      # 或：node test/run-all.js
```

280 条自动化测试（运行后见 `test-report.json`）：状态机、任务 DAG、调度器、仓库、diff、三路合并、PR 门禁、CI 流水线、权限、审计、持久化、终端、演示场景、HTTP API、i18n 字典完整性（en/zh-CN 键位对齐、占位符对齐、孤儿键/引用扫描），以及 Windows 桌面启动器（端口选取、launch-info 握手、图标格式、启动脚本接线、无头启动）。编排套件使用可注入的 fake 适配器跑通完整流水线——实现 → 门禁 → 评审 → CI → 人工/自动合并、要求修改门控、熔断器、空产出拒绝与沙箱路径禁闭——外加基于 fixture 的 ACP 客户端套件（握手、会话周期、权限自动放行、在飞请求退出拒绝），因此编排逻辑的验证不花 token；真实 CLI 另行冒烟验证。

## 架构

```
浏览器（原生 ES Modules）              服务端（Node http，零依赖）
┌─────────────────────────┐           ┌────────────────────────────────────┐
│ main.js  路由+快捷键     │  fetch    │ index.js ─ main.js                 │
│ store.js 轮询状态        │ ────────► │ routes-core/repo/collab + jsonio   │
│ views/*  11 个视图       │ ◄──────── │ static.js（静态资源）               │
│ actions.js 操作守卫      │  JSON     │ terminal.js（工作区 shell）         │
│ i18n.js  中英切换        │           │ domain/ workspace 门面+权限+审计    │
└─────────────────────────┘           │  tasks(DAG+FSM+调度) repo(blob/tree │
                                      │  /commit) merge(diff3) pr ci agents│
                                      │ agents/runners.js 内置执行器        │
                                      │ engines/ harness(vm沙箱) lint       │
                                      │  security build review             │
                                      │ orchestration/ 真实 CLI 编排器      │
                                      │  export(隔离快照) adapters(codex/   │
                                      │  claude) orchestrator(流水线+门)    │
                                      │ demo/ 种子 + 15 步场景              │
                                      └────────────────────────────────────┘
```

- **统一消息协议**：每个 agent 动作都投递 `{id, agent, timestamp, task, status, input, output, artifacts, dependencies}`。
- **任务状态机**：`blocked → ready → running → completed|failed|paused → …`；`failed --retry--> ready`；非终态可取消。非法转换抛出 `FORGE_INVALID_TRANSITION` 并指明具体转换对。
- **调度器**：依赖满足时 `blocked → ready`；容器任务（拆分父任务）在全部子任务完成后自动完成；可选自动调度器领取并执行就绪任务。
- **虚拟仓库**：内容寻址 blob（SHA-256）、扁平树、哈希链提交（tree+parents+message+author+timestamp）、分支引用、带脏检测的工作树、diff3 三路合并（冲突标记 + ours/theirs/手动解决）。
- **PR 门禁**：合并要求 head SHA 上最新 CI run 的全部必要检查通过**且**至少一个绑定该 head 的批准；新提交后旧批准失效；冲突以 `FORGE_CONFLICT` 呈现并在目标分支上解决。
- **CI**：lint / unit / integration / security / build 每个阶段都是跑在真实快照上的真实引擎；仓库测试在锁定权限的 `vm` 沙箱中执行（迷你 describe/it/assert + 仓库相对 require，无法访问 fs/process）。
- **权限**：角色 × 动作矩阵（admin/planner/implementer/reviewer/qa/security/viewer/system）在工作台门面处强制执行；可开关，始终记审计。
- **持久化**：每次变更原子写入（tmp+rename）`data/workspace.json`；导入/导出使用同一信封（`format: "forge.workspace", version: 1`）。
- **审计**：追加式日志记录每一次重要状态变化（actor + from/to，上限 5000 条）。
- **多语言界面**：英文 / 简体中文，侧边栏或设置中切换；偏好保存在 `localStorage`（首次访问自动检测浏览器语言）；全部界面文案、状态词、严重性、提示都经由单一字典（`public/js/i18n/messages.json`）与 `{param}` 插值本地化。

## 安全说明

- 服务器**不发出任何出站请求**；唯一的 URL 解析就是本地 HTTP 服务器自身的请求目标。
- 所有 JSON 响应经由单一编码通道（`jsonio.encodeJson`：中和 `< > & U+2028 U+2029`，OWASP JSON 加固）并带 `X-Content-Type-Options: nosniff`；静态服务独立模块并做路径禁闭。
- 仓库测试在无宿主全局的 `vm` 沙箱中执行；仓库路径经过校验（拒绝 `../`、绝对路径等）；请求体有限流并做 JSON 校验；每个 API 错误都是带稳定错误码的类型化 `ForgeError`。

## 已知限制

- 单用户本地工作台（API actor 固定为本地 admin），无认证体系。
- 沙箱测试框架支持同步/promise 用例与扁平 describe，无 beforeEach/afterEach 钩子。
- 安全扫描为确定性模式匹配（非污点分析）；lint 不覆盖多行空 catch 等复杂形态。
- 冲突解决粒度为文件级（ours/theirs/手动全文），无逐 hunk 选择；rename/rename 冲突未建模。
- 审计（5000 条）与消息（4000 条）有上限裁剪，不归档；自动调度器为顺序执行非并发模型。
- 演示场景通过真实 API 逐步编排，但步骤序列本身是固定的（这是演示，不是自主 planner）。
- 服务端字符串（API 错误消息、终端命令输出、演示步骤名）仅英文；i18n 层覆盖 Web 界面。语言是客户端偏好，不属于持久化的工作台状态。
- 桌面应用是基于本地服务器的应用模式浏览器窗口（非 Electron 式打包），因此需要 PATH 上有 Node.js；仅支持 Windows（VBS 启动器）。单文件 exe 打包超出范围。
- 外部编排器失败后需人工点重试（不自动重试，防止烧 token）；dsh 适配器经官方 ACP 自动化协议接入（需 dsh 已登录 DeepSeek），zcode 经无头 CLI 接入（依赖本地安装）。
