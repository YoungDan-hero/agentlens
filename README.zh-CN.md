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
- **网络** —— 每个 `fetch` 与 `XMLHttpRequest`（含 axios）请求的方法、状态码、耗时，以及发起该请求的源码位置
- **用户交互** —— 点击、防抖后的输入、表单提交，每个交互都归因到渲染该元素的源码行
- **生命周期** —— 页面加载、SPA 路由跳转、HMR 热更新、页面卸载

**信号智能处理**（daemon 侧）：

- **错误去重折叠** —— 相同错误折叠为一条记录并累计出现次数，渲染循环里的错误风暴不会把有用信号冲出缓冲区
- **会话隔离** —— 每次页面加载 / 每个标签页是独立会话，查询默认作用于最近活跃的会话
- **源码归因** —— Vite 插件为 JSX 元素注入 `data-agentlens-source="文件:行号"`，DOM 节点、点击事件、布局盒子都能追溯到代码

**面向 Agent 的六个 MCP 工具**：

| 工具                       | 回答的问题                                                     |
| -------------------------- | -------------------------------------------------------------- |
| `get_page_health`          | "页面现在健康吗？"——错误数、失败请求数、最近活动概览           |
| `get_recent_events`        | "给我看错误 / 日志 / 请求"——支持类型、会话、时间过滤的钻取查询 |
| `get_interaction_timeline` | "用户做了什么导致这个错误？"——交互与其触发效果的因果分组       |
| `get_layout_snapshot`      | "页面现在长什么样？"——结构化盒模型树，无需截图                 |
| `verify_fix`               | "我的修复生效了吗？"——等待 HMR 后观察错误是否复发              |
| `list_sessions`            | "有哪些标签页 / 会话在连接？"——会话管理                        |

## 实际运用场景

- **自主调试闭环** —— Agent 改完代码后调用 `get_page_health`，发现一个新错误，source map 还原的堆栈直指 `src/App.tsx:42`；Agent 修复后调用 `verify_fix` 确认错误不再复发——全程不需要你打开 DevTools 粘贴任何东西。
- **"我改完就坏了"** —— `get_interaction_timeline` 把"点击了提交按钮 → 触发了一个 500 请求 → 随后抛出未处理 rejection"作为一个因果组呈现，Agent 直接看到事故链条。
- **布局与样式问题** —— `get_layout_snapshot` 给 Agent 一棵结构化的盒子树：每个元素的位置、尺寸、可见性、是否溢出、直接文本，以及渲染它的源码行。"侧边栏溢出了"从一句模糊描述变成可定位的事实。
- **修复验证** —— Agent 拿着错误的 `fingerprint` 调用 `verify_fix`，daemon 等待新代码通过 HMR 到达浏览器，然后在静默窗口内观察错误是否复发，给出明确结论。

## 使用说明

### 第一步：安装 Vite 插件

```bash
pnpm add -D @agentlensjs/vite-plugin
# 或：npm install -D @agentlensjs/vite-plugin
```

```ts
// vite.config.ts
import { defineConfig } from 'vite';
import { agentlens } from '@agentlensjs/vite-plugin';

export default defineConfig({
  plugins: [agentlens()],
});
```

插件只在 `serve`（开发服务器）模式下生效，生产构建完全不受影响。可选配置：

```ts
agentlens({
  port: 8631, // daemon 端口（如有修改）
  enabled: true, // 需要时可强制关闭注入
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

完整可运行的示例在 [`examples/react-demo`](./examples/react-demo)，包含自动化端到端验证：

```bash
pnpm build && pnpm --filter react-demo e2e
```

### MCP 工具详细说明

**`get_page_health`** —— 建议 Agent 首先调用的工具。返回最近 5 分钟内的健康概览：去重后的错误数、含折叠重复的错误总次数、失败请求数、最近活动时间。默认作用于最近活跃的会话，可传 `sessionId` 指定。

**`get_recent_events`** —— 钻取查询。支持按 `type`（error / console / network / lifecycle / interaction）、`sessionId`、`sinceMs`（时间戳下界）、`limit`（默认 50，最大 200）过滤，返回最新在前的事件列表。错误事件带有 `fingerprint` 字段和 source map 还原后的 `frames`。

**`get_interaction_timeline`** —— 因果视图。把用户交互（点击 / 输入 / 提交，均带元素的源码归因）与其后发生的错误、请求、日志分组呈现。`windowMs` 控制归因窗口（默认 3000ms），窗口被下一次交互截断。不属于任何交互的事件归入 `background`。

**`get_layout_snapshot`** —— 实时布局快照。向浏览器请求一棵结构化盒模型树：每个可见元素的标签、视口矩形、可见性、溢出状态、直接文本，以及 `data-agentlens-source` 源码归因。节点预算默认 800，超出时标记 `truncated`。

**`verify_fix`** —— 修复验证闭环。传入错误的 `fingerprint`（从 `get_recent_events` 获取），工具分两阶段工作：先等待新代码到达浏览器（HMR 或整页刷新，最长 `timeoutMs`，默认 10 秒），然后在 `quietWindowMs`（默认 3 秒）静默窗口内观察该指纹是否复发。注意：只由用户交互触发的错误需要重新触发交互才能完全确认，返回结果中会明确说明。

**`list_sessions`** —— 列出所有已知会话（每次页面加载 / 每个标签页一个），按最近活跃排序。多标签页并行时用返回的 `sessionId` 圈定其他工具的查询范围。

## 包结构

| 包                                                   | 说明                                   |
| ---------------------------------------------------- | -------------------------------------- |
| [`@agentlensjs/vite-plugin`](./packages/vite-plugin) | 注入 runtime 并为 JSX 打上源码归因属性 |
| [`@agentlensjs/runtime`](./packages/runtime)         | 浏览器内的信号采集 SDK                 |
| [`@agentlensjs/mcp-server`](./packages/mcp-server)   | daemon：事件存储、堆栈还原、MCP 工具   |
| [`@agentlensjs/shared`](./packages/shared)           | 线上协议与共享类型定义                 |

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

## 已知限制

- **仅支持 Vite** —— runtime 通过 `@agentlensjs/vite-plugin` 注入，暂不支持其他构建工具。
- **不捕获 `sendBeacon` / WebSocket** —— 网络采集覆盖 `fetch` 与 `XMLHttpRequest`，beacon 与 socket 流量不会被记录。
- **内存存储** —— daemon 将事件保存在有界内存缓冲区中，重启即清空。作为开发期工具，这是有意的设计。
- **不遍历 iframe / shadow DOM** —— 布局快照仅覆盖顶层文档。

## 许可证

[MIT](./LICENSE)
