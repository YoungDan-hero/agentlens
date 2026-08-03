# AgentLens

> AI Agent 的 DevTools —— 一个运行时反馈层，让 AI 编程助手拥有"看见浏览器"的能力。

[![CI](https://github.com/YoungDan-hero/agentlens/actions/workflows/ci.yml/badge.svg)](https://github.com/YoungDan-hero/agentlens/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/%40agentlensjs%2Fmcp-server)](https://www.npmjs.com/package/@agentlensjs/mcp-server)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

**[English](./README.md)**

AI 编程助手能写前端代码，却看不见浏览器里发生了什么。页面报错、白屏、请求失败时，Agent 只能靠猜，或者反复让你粘贴控制台输出。AgentLens 打通了这个闭环：在开发阶段自动采集浏览器运行时信号，通过 MCP 协议提供给任何兼容的 Agent（Cursor、Claude Code 等），并且每个信号都能定位到源码位置。

```
┌─────────────┐  WebSocket  ┌───────────────┐  MCP (stdio)  ┌─────────┐
│    浏览器     │ ──────────▶ │  AgentLens     │ ◀───────────▶ │  Agent  │
│  runtime SDK │             │  daemon        │               │ (Cursor)│
└─────────────┘             └───────────────┘               └─────────┘
       ▲ 由 Vite 插件注入
┌─────────────┐
│  Vite 插件   │
└─────────────┘
```

## 功能特性

**运行时信号采集**（零代码侵入，仅开发模式生效）：

- **错误** —— 未捕获异常与未处理的 Promise rejection，堆栈经 source map 还原到原始源码文件与行号
- **控制台** —— 五个级别（`log` / `info` / `warn` / `error` / `debug`）全量捕获，参数安全序列化并限长
- **网络** —— 每个 `fetch`、`XMLHttpRequest`（含 axios）、WebSocket 连接与 `sendBeacon` 调用的方法、状态码、耗时，以及发起请求的源码位置；请求/响应体可选捕获（需显式开启，且经过脱敏）
- **性能** —— Web Vitals（FCP、LCP、CLS、INP、TTFB，附带 web.dev 评级）与长任务，基于原生 `PerformanceObserver`，零额外依赖
- **用户交互** —— 点击、防抖后的输入、表单提交，每个交互都归因到渲染该元素的源码行
- **生命周期** —— 页面加载、SPA 路由跳转、HMR 热更新、页面卸载

**信号智能处理**（daemon 侧）：

- **错误去重折叠** —— 相同错误折叠为一条记录并累计出现次数，渲染循环里的错误风暴不会把有用信号冲出缓冲区
- **会话隔离** —— 每次页面加载 / 每个标签页是独立会话，查询默认作用于最近活跃的会话
- **源码归因** —— Vite 插件为 Vue SFC 模板元素与 JSX 宿主元素注入 `data-agentlens-source="文件:行号"`，DOM 节点、点击事件、布局盒子都能追溯到代码

**浏览器动作通道**（显式开启）：

- **Agent 驱动的测试** —— 开启 `allowActions: true` 后，Agent 可以在你真实的开发会话里点击、输入、选择下拉项、滚动、同源导航——无需另起浏览器、没有冷启动，且所有 AgentLens 信号都可用作断言
- **真人优先** —— 你正在操作页面时，Agent 的动作会被拒绝并稍后重试，人类输入永远优先
- **留痕可审计** —— 每个合成交互都带 `synthetic: true` 标记入库，被操作的元素会闪现高亮描边

**面向 Agent 的十个 MCP 工具**：

| 工具                       | 回答的问题                                                     |
| -------------------------- | -------------------------------------------------------------- |
| `get_page_health`          | "页面现在健康吗？"——错误数、失败请求数、最近活动概览           |
| `get_error_context`        | "这个错误为什么发生？"——一次调用拿到根因上下文包               |
| `get_recent_events`        | "给我看错误 / 日志 / 请求"——支持类型、会话、时间过滤的钻取查询 |
| `get_interaction_timeline` | "用户做了什么导致这个错误？"——交互与其触发效果的因果分组       |
| `get_layout_snapshot`      | "页面现在长什么样？"——结构化盒模型树，无需截图                 |
| `get_performance`          | "页面为什么慢？"——Web Vitals 评级与长任务压力                  |
| `perform_action`           | "帮我点那个按钮 / 填那个表单"——驱动真实页面（需显式开启）      |
| `wait_for_idle`            | "应用反应完了吗？"——阻塞等待事件流静默                         |
| `verify_fix`               | "我的修复生效了吗？"——等待 HMR 后观察错误是否复发              |
| `list_sessions`            | "有哪些标签页 / 会话在连接？"——会话管理                        |

## 实际运用场景

- **自主调试闭环** —— Agent 改完代码后调用 `get_page_health`，发现一个新错误，source map 还原的堆栈直指 `src/App.vue:42`；Agent 修复后调用 `verify_fix` 确认错误不再复发——全程不需要你打开 DevTools 粘贴任何东西。
- **一次调用定位根因** —— `get_error_context` 把错误本体、之前的用户交互（带元素源码归因）、同时间窗内的网络请求与控制台警告、会话的 Web Vitals 打包返回，Agent 不再需要跨工具人肉关联。
- **"我改完就坏了"** —— `get_interaction_timeline` 把"点击了提交按钮 → 触发了一个 500 请求 → 随后抛出未处理 rejection"作为一个因果组呈现，Agent 直接看到事故链条。
- **布局与样式问题** —— `get_layout_snapshot` 给 Agent 一棵结构化的盒子树：每个元素的位置、尺寸、可见性、是否溢出、直接文本，以及渲染它的源码行。"侧边栏溢出了"从一句模糊描述变成可定位的事实。
- **性能回归** —— `get_performance` 返回当前的 Web Vitals 评级与长任务压力，"页面感觉很卡"变成"INP 620ms（poor），14 个长任务共 2.1 秒"。
- **修复验证** —— Agent 拿着错误的 `fingerprint` 调用 `verify_fix`，daemon 等待新代码通过 HMR 到达浏览器，然后在静默窗口内观察错误是否复发，给出明确结论。
- **会话内自动化测试** —— 开启动作通道后，Agent 可以自己复现 bug：`perform_action` 点击那个出错的按钮（用 `data-agentlens-source` 定位，重构后依然稳定），`wait_for_idle` 等应用反应完毕，动作结果直接报告它触发了多少错误和失败请求——不离开你的开发会话就完成一轮回归检查。

## 使用说明

### 第一步：安装 Vite 插件

```bash
pnpm add -D @agentlensjs/vite-plugin
# 或：npm install -D @agentlensjs/vite-plugin
```

```ts
// vite.config.ts —— Vue 项目
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { agentlens } from '@agentlensjs/vite-plugin';

export default defineConfig({
  plugins: [vue(), agentlens()],
});
```

```ts
// vite.config.ts —— React 项目
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { agentlens } from '@agentlensjs/vite-plugin';

export default defineConfig({
  plugins: [react(), agentlens()],
});
```

源码归因对两个生态都生效：Vue SFC 模板（`.vue`）与 JSX/TSX 宿主元素都会自动打上 `data-agentlens-source="文件:行号"`。插件只在 `serve`（开发服务器）模式下生效，生产构建完全不受影响。可选配置：

```ts
agentlens({
  port: 8631, // daemon 端口（如有修改）
  enabled: true, // 需要时可强制关闭注入
  captureBodies: false, // 显式开启后才捕获请求/响应体（自动脱敏）
  redactKeys: ['idCard', 'mobile'], // 项目自定义敏感字段，叠加在内置规则之上
  allowActions: false, // 显式开启后 Agent 才能通过 perform_action 驱动页面
});
```

### 第二步：在 Agent 中注册 MCP 服务

**Cursor**（项目内 `.cursor/mcp.json`，或全局设置）：

```json
{
  "mcpServers": {
    "agentlens": {
      "command": "npx",
      "args": ["-y", "@agentlensjs/mcp-server"]
    }
  }
}
```

**Claude Code**：

```bash
claude mcp add agentlens -- npx -y @agentlensjs/mcp-server
```

daemon 随 Agent 自动启动，在 `ws://localhost:8631` 监听浏览器连接（仅绑定本机回环地址，局域网不可访问）。如需更换端口：给 daemon 设置环境变量 `AGENTLENS_PORT`，并把相同的值传给插件的 `port` 选项。

### 第三步：正常开发

运行 `npm run dev`（即项目里启动 Vite 开发服务器的脚本）并打开页面，runtime 会自动连接 daemon。然后就可以直接问 Agent：

- _"页面现在有报错吗？"_
- _"我刚才点结账按钮的时候发生了什么？"_
- _"页面上有什么元素溢出了吗？"_
- _"我已经修复了，验证一下那个错误是不是没了。"_

完整可运行的示例在 [`examples/vue-demo`](./examples/vue-demo) 与 [`examples/react-demo`](./examples/react-demo)，均包含自动化端到端验证：

```bash
pnpm build && pnpm --filter vue-demo e2e
```

### 非 Vite 项目：手动接入

Vite 插件只是便利层，不是必需品。采集 SDK 是纯浏览器代码——Webpack、Next.js、基于 Webpack 的 Nuxt 等任何工具链，都可以直接安装并在客户端入口手动初始化：

```bash
npm install -D @agentlensjs/runtime
```

```ts
// 客户端入口（如 src/main.tsx）—— 仅开发模式
if (process.env.NODE_ENV === 'development') {
  void import('@agentlensjs/runtime').then(({ init }) => {
    init();
  });
}
```

环境判断 + 动态 import 保证 SDK 完全不会进入生产构建。`init` 支持的选项：

```ts
init({
  endpoint: 'ws://localhost:8631/agentlens', // 如修改过 AGENTLENS_PORT，保持一致
  captureBodies: false, // 显式开启后才捕获请求/响应体（自动脱敏）
  redactKeys: ['idCard', 'mobile'], // 项目自定义敏感字段
  allowActions: false, // 显式开启后 Agent 才能通过 perform_action 驱动页面
});
```

这个模式有一个固有限制：采集器要等动态 import 的 chunk 加载完成后才存在，应用启动期间**同步**触发的信号不会被捕获。该接入方式由 [`examples/webpack-demo`](./examples/webpack-demo) 中的自动化冒烟测试持续验证。

手动接入模式下，上述全部能力可用——错误、控制台、网络、性能、交互、布局快照、动作通道，以及全部十个 MCP 工具——只有两处降级：

- **源码归因** —— `data-agentlens-source` 由 Vite 插件的模板/JSX 转换注入，没有插件时，交互与布局盒子只能用 tag / id / class 描述元素，无法给出 `文件:行号`。
- **`verify_fix`** —— daemon 接受 HMR 信号或整页刷新两种"新代码已到达浏览器"的证据。刷新开箱即用；想走更快的 HMR 路径，把构建工具的热更新 API 接到 `reportHmrUpdate` 即可：

```ts
// webpack 5 —— 可选，不接也能靠整页刷新工作
if (process.env.NODE_ENV === 'development') {
  void import('@agentlensjs/runtime').then(({ init }) => {
    const client = init();
    import.meta.webpackHot?.addStatusHandler((status) => {
      if (status === 'idle') client.reportHmrUpdate();
    });
  });
}
```

Next.js 项目需保证代码只在客户端执行——放在 [`instrumentation-client.ts`](https://nextjs.org/docs/app/api-reference/file-conventions/instrumentation-client)（Next 15.3+）或挂载在根布局的 `'use client'` 组件里。

### MCP 工具详细说明

**`get_page_health`** —— 建议 Agent 首先调用的工具。返回最近 5 分钟内的健康概览：去重后的错误数、含折叠重复的错误总次数、失败请求数、最近活动时间。默认作用于最近活跃的会话，可传 `sessionId` 指定。

**`get_recent_events`** —— 钻取查询。支持按 `type`（error / console / network / lifecycle / interaction / performance）、`sessionId`、`sinceMs`（时间戳下界）、`limit`（默认 50，最大 200）过滤，返回最新在前的事件列表。错误事件带有 `fingerprint` 字段和 source map 还原后的 `frames`。

**`get_error_context`** —— 根因上下文包。传入错误的 `fingerprint` 或事件 `id`（不传则取最近一个错误），一次返回：折叠后的错误记录（含 source map 还原的堆栈）、最近一次发生之前的用户交互（带元素源码归因，最多 5 条）、同时间窗内的网络请求与控制台警告/错误（各最多 10 条）、以及该会话的 Web Vitals 画像。`lookbackMs` 控制向前追溯的窗口（默认 15 秒）。这是诊断单个错误的首选入口，替代跨多个工具的手动关联。

**`get_interaction_timeline`** —— 因果视图。把用户交互（点击 / 输入 / 提交，均带元素的源码归因）与其后发生的错误、请求、日志分组呈现。`windowMs` 控制归因窗口（默认 3000ms），窗口被下一次交互截断。不属于任何交互的事件归入 `background`。

**`get_layout_snapshot`** —— 实时布局快照。向浏览器请求一棵结构化盒模型树：每个可见元素的标签、视口矩形、可见性、溢出状态、直接文本，以及 `data-agentlens-source` 源码归因。节点预算默认 800，超出时标记 `truncated`。

**`get_performance`** —— 性能画像。返回当前会话每项 Web Vital 的最新读数（FCP / LCP / CLS / INP / TTFB，各自附带 web.dev 三档评级 good / needs-improvement / poor）以及长任务汇总（数量、总时长、最长一次、最近列表）。适合回答"页面为什么慢"，以及在性能优化后复查指标变化。

**`perform_action`** —— 浏览器动作通道（需应用侧 `allowActions: true` 显式开启）。让 Agent 在用户真实的开发会话里执行页面动作：`click` 点击、`input` 输入（兼容 React 受控组件与 Vue v-model）、`select` 选择下拉项、`scroll` 滚动、`navigate` 同源导航。元素定位三选一：`source`（`data-agentlens-source` 的 `文件:行号` 值，重构后最稳定）、`selector`（CSS 选择器）、`text`（可见文本，取最深匹配）；多个匹配时用 `nth` 消歧。动作派发后运行时等待页面静默（settle），返回实际命中的元素、静默耗时，以及动作触发的错误 / 失败请求 / 控制台错误计数。安全边界：用户 1.5 秒内有真实输入时动作被拒绝（稍后重试即可）、同一时间只执行一个动作、跨域导航一律拒绝、每个合成交互都带 `synthetic: true` 标记入库留痕、被操作元素闪现高亮描边。

**`wait_for_idle`** —— 等待应用静默。阻塞直到会话的事件流连续 `quietMs`（默认 1 秒）没有新事件，或 `timeoutMs`（默认 10 秒）超时。在 `perform_action` 之后、断言页面状态之前调用，避免在应用还在反应时过早查询。

**`verify_fix`** —— 修复验证闭环。传入错误的 `fingerprint`（从 `get_recent_events` 获取），工具分两阶段工作：先等待新代码到达浏览器（HMR 或整页刷新，最长 `timeoutMs`，默认 10 秒），然后在 `quietWindowMs`（默认 3 秒）静默窗口内观察该指纹是否复发。注意：只由用户交互触发的错误需要重新触发交互才能完全确认，返回结果中会明确说明——现在 Agent 可以直接用 `perform_action` 重新触发那次交互。

**`list_sessions`** —— 列出所有已知会话（每次页面加载 / 每个标签页一个），按最近活跃排序。多标签页并行时用返回的 `sessionId` 圈定其他工具的查询范围。

## 包结构

| 包                                                   | 说明                                             |
| ---------------------------------------------------- | ------------------------------------------------ |
| [`@agentlensjs/vite-plugin`](./packages/vite-plugin) | 注入 runtime，为 Vue 模板与 JSX 打上源码归因属性 |
| [`@agentlensjs/runtime`](./packages/runtime)         | 浏览器内的信号采集 SDK                           |
| [`@agentlensjs/mcp-server`](./packages/mcp-server)   | daemon：事件存储、堆栈还原、MCP 工具             |
| [`@agentlensjs/shared`](./packages/shared)           | 线上协议与共享类型定义                           |

## 本地开发

需要 Node.js >= 22.13（pnpm 11 依赖 `node:sqlite` 内置模块）和 [pnpm](https://pnpm.io)。

```bash
pnpm install
pnpm build      # 构建所有包
pnpm test       # 运行测试
pnpm lint       # 代码检查
pnpm typecheck  # 类型检查
```

完整贡献流程见 [CONTRIBUTING.md](./CONTRIBUTING.md)。

## 隐私与数据安全

AgentLens 是开发期工具，从设计上保证敏感数据不出本机：

- **仅回环地址** —— daemon 只绑定 `127.0.0.1`，局域网不可达，任何数据都不会上传到任何地方。
- **Origin 门禁** —— 回环绑定挡不住*网页*：WebSocket 握手不受同源策略约束，所以 daemon 还会拒绝所有非本地 Origin 的握手。浏览器里打开的恶意网站无法连上 daemon、向 Agent 的上下文注入伪造事件。需要信任额外来源时用 `AGENTLENS_ALLOWED_ORIGINS`。
- **事件深度校验** —— 每个入库事件都逐字段做 schema 校验，畸形载荷到不了存储层（也到不了 Agent）。
- **请求头永不采集** —— `Authorization`、`Cookie` 等请求/响应头从设计上就不收集，无需事后擦除。
- **请求体默认不采集、开启后自动脱敏** —— 只有显式设置 `captureBodies: true` 才捕获请求/响应体；即便开启，`password`、`token`、`secret`、`authorization` 等敏感字段也会在浏览器内先替换为 `[REDACTED]` 再发出，且限长 4KB。项目自定义敏感字段（如 `idCard`）用 `redactKeys` 选项追加。
- **URL 默认脱敏** —— 每个网络事件的 `?token=...`、`?apiKey=...` 等敏感查询参数值一律擦除。
- **表单值永不采集** —— 交互事件只记录元素本身，不记录用户输入的内容。
- **动作通道默认关闭** —— `perform_action` 只在应用显式设置 `allowActions: true` 后才工作。即使开启：用户正在操作时动作会被拒绝（真人输入永远优先）、导航被限制在应用自身源内、每个合成交互都以 `synthetic: true` 标记入库可审计。

发现安全漏洞？请通过私密渠道报告——见 [SECURITY.md](./SECURITY.md)。

## 设计决策

### 有意不做持久化

daemon 将事件保存在有界内存缓冲区中，重启即清空全部历史。这是刻意的取舍，不是待补的功能：

- **过期的运行时数据比没有数据更糟。** 事件描述的是采集那一刻的代码。daemon 重启后代码通常已经变了——行号漂移、source map 重新生成——恢复出来的旧错误会把 Agent 指向已经不存在的代码。对修复闭环来说，误导性的历史严格劣于空缓冲区。
- **重启不会发生在会话中途。** daemon 与 MCP 客户端（Cursor、Claude Code）同生共死，它不是需要崩溃恢复的常驻服务。
- **纯内存本身就是隐私保证。** 任何数据都不落盘，进程一死信号即消失。一旦持久化，就要处理包含请求数据的文件的权限、保留期与清理策略——为可忽略的收益付出真实的成本。
- **AgentLens 是反馈回路，不是 APM。** 跨会话的错误历史是监控产品（Sentry 之类）的职责。保持 daemon 无状态，才能保持定位清晰。

## 已知限制

- **仅支持 Vite** —— 其他构建工具可用[手动接入](#非-vite-项目手动接入)：信号与工具全部保留，仅损失 `文件:行号` 源码归因。
- **不记录 WebSocket 消息帧** —— 连接的建立与失败会被捕获，消息内容不会。
- **内存存储** —— daemon 重启即清空历史，原因见[设计决策](#设计决策)。
- **不遍历 iframe / shadow DOM** —— 布局快照仅覆盖顶层文档。

## 许可证

[MIT](./LICENSE)
