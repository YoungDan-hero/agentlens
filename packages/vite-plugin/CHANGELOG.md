# @agentlensjs/vite-plugin

## 0.8.0

### Minor Changes

- 90a9e4e: feat: M6 修复验证引擎——会话聚焦信号、反向源码查询、批量动作序列与一键错误回放

  - **会话聚焦信号**：runtime 在每次连接建立与可见性/聚焦变化时上报 `focus-update`，daemon 选择快照/动作目标会话时优先聚焦页面（聚焦 > 可见 > 状态未知 > 后台），`list_sessions` 返回每个会话的实时 `connected` / `visible` / `focused` 状态——多标签页时 Agent 操作的是用户眼前的页面
  - **反向源码查询**：新增 `find_elements_by_source` 工具，列出某个源码文件（`src/App.vue` 或精确 `src/App.vue:42`）当前在页面上渲染的所有元素；`get_recent_events` 新增 `source` 过滤（匹配元素交互、解析后错误堆栈与请求发起方，兼容相对/绝对/仅文件名三种 sourcemap 路径风格）
  - **批量动作序列**：新增 `perform_actions` 工具与 `action-sequence-request/result` 协议，一次往返顺序执行最多 20 步动作；每步可声明 `waitFor` 本地等待条件（visible / attached / hidden + 超时），运行时在浏览器内轮询，异步 UI 无需 Agent 往返；遇失败或用户接管立即停止并报告断点（`stoppedAt` / `stopReason`）、每步结果与累计效果；`navigate` 仅允许作为最后一步
  - **一键错误回放**：新增 `replay_error_path` 工具，把错误发生前的真人交互（过滤合成交互）推导成动作序列脚本；默认 dry run 供审阅，输入步骤因输入值从不采集而标记 `needsValue` 由调用方补值；执行后对比错误指纹发生次数并返回 `errorRecurred`——修复验证一条命令闭环

### Patch Changes

- Updated dependencies [90a9e4e]
  - @agentlensjs/shared@0.8.0
  - @agentlensjs/runtime@0.8.0

## 0.7.0

### Minor Changes

- ed84776: feat: 新增浏览器动作通道（M5b）——Agent 可在用户真实开发会话内执行自动化测试。协议层新增 ActionRequest/ActionResult 消息与 InteractionEvent.synthetic 审计标记；runtime 新增动作执行器：三级元素定位（data-agentlens-source → CSS 选择器 → 可见文本最深匹配，nth 消歧）、合成事件派发按真实浏览器顺序 pointerdown → mousedown → focus → pointerup → mouseup → click（pointer 事件兼容 Radix / Headless UI 等监听 onPointerDown 的组件库，focus 对齐 Playwright 语义；原型 setter 写入兼容 React 受控组件，input+change 事件兼容 Vue v-model，HTMLElement.click 触发真实激活行为）、页面静默判定（settle）与动作副作用统计（错误/失败请求/控制台错误）、目标元素高亮描边；安全模型：allowActions 默认关闭需显式开启、用户 1.5 秒内有真实输入时拒绝执行（真人优先）、同时只执行一个动作、导航仅限同源、每个合成交互带 synthetic: true 入库留痕；mcp-server 新增 perform_action 与 wait_for_idle 两个 MCP 工具（工具总数 8 → 10）；vite-plugin 透传 allowActions 选项
- 3bd6e71: feat: Vue 一等公民支持——新增基于 @vue/compiler-dom 的 SFC 模板源码归因注入器，为模板中的原生元素自动打上 data-agentlens-source="文件:行号"（组件标签与 template/slot 包装不注入，支持插槽内容递归、跳过 pug/外部模板与 ?raw/?url 资产请求、容忍编辑中的可恢复解析错误），交互时间线与布局快照在 Vue 项目中同样可以追溯到源码行；同时修复 CJS 产物中 magic-string 的 ESM interop 崩溃（改用具名导入，require() 加载插件的项目此前一旦命中注入路径即报 "not a constructor"）

### Patch Changes

- Updated dependencies [ed84776]
  - @agentlensjs/shared@0.7.0
  - @agentlensjs/runtime@0.7.0

## 0.6.1

### Patch Changes

- Updated dependencies [9f44905]
  - @agentlensjs/runtime@0.6.1
  - @agentlensjs/shared@0.6.0

## 0.6.0

### Minor Changes

- 54e7c5d: feat: 安全加固——ingest 端点 Origin 门禁（拒绝非本地来源握手，支持 AGENTLENS_ALLOWED_ORIGINS 白名单）、入库事件逐字段 zod 深校验、协议版本不匹配时输出诊断日志、新增 redactKeys 选项支持项目自定义敏感字段脱敏

### Patch Changes

- Updated dependencies [cb1bd1f]
- Updated dependencies [54e7c5d]
  - @agentlensjs/runtime@0.6.0

## 0.5.1

### Patch Changes

- df03e30: docs: 包级 README 同步 0.5.0 能力——补充 get_performance 工具、性能/WebSocket/sendBeacon 采集、captureBodies 选项与隐私说明
- Updated dependencies [df03e30]
  - @agentlensjs/shared@0.5.1
  - @agentlensjs/runtime@0.5.1

## 0.5.0

### Minor Changes

- 902b42e: feat: 性能采集、网络捕获补全与敏感数据脱敏

  - 新增 performance 事件与 `get_performance` MCP 工具：基于原生 PerformanceObserver 采集 Web Vitals（FCP/LCP/CLS/INP/TTFB，附 web.dev 评级）与长任务，零额外依赖
  - 网络捕获补全：新增 WebSocket 连接（成功/失败）与 sendBeacon 调用拦截，NetworkEvent 增加 transport 判别字段
  - 请求/响应体捕获（opt-in）：插件/运行时新增 `captureBodies` 选项，body 经敏感字段脱敏（password/token/secret/authorization 等替换为 [REDACTED]）并限长 4KB 后才发出
  - 隐私加固：所有网络事件的 URL 敏感查询参数默认擦除；请求头从设计上永不采集；beacon 事件不再被健康摘要误计为失败请求

### Patch Changes

- Updated dependencies [902b42e]
  - @agentlensjs/shared@0.5.0
  - @agentlensjs/runtime@0.5.0

## 0.4.4

### Patch Changes

- Updated dependencies
  - @agentlensjs/runtime@0.4.2

## 0.4.3

### Patch Changes

- Updated dependencies
  - @agentlensjs/runtime@0.4.1

## 0.4.2

### Patch Changes

- 修复只安装插件时虚拟模块无法解析 runtime 的问题。`@agentlensjs/runtime` 现在是插件的直接依赖，虚拟模块改为通过 `@agentlensjs/vite-plugin/runtime` 真实文件入口转发导入——虚拟模块没有磁盘位置，裸导入只能从项目根解析（用户项目未安装 runtime 时报 "Failed to resolve import"）；从插件自身的真实文件转发后，解析顺着插件的依赖链完成，npm/pnpm/yarn 均可用，用户只需安装 `@agentlensjs/vite-plugin` 一个包

## 0.4.1

### Patch Changes

- 放宽 vite 对等依赖下限至 `>=4.0.0`。插件使用的全部 Vite API（configResolved、transform、虚拟模块、transformIndexHtml 标签注入、vite:afterUpdate HMR 事件）在 Vite 4 中均可用，原 `>=5.0.0` 的限制过于保守，导致 Vite 4 项目安装时报 ERESOLVE 冲突

## 0.4.0

### Minor Changes

- 12ad090: 网络采集新增 `XMLHttpRequest` 拦截：通过 patch `open`/`send` 原型方法并监听 `loadend`，捕获方法、URL、状态码、耗时与发起方堆栈。axios 默认浏览器适配器等基于 XHR 的请求库现在同样被完整记录；状态码 0（网络失败 / 超时 / 中止）归一为 `null` 状态与 fetch 侧语义对齐。其余包同步升版保持版本对齐

### Patch Changes

- Updated dependencies [12ad090]
  - @agentlensjs/shared@0.4.0

## 0.3.0

### Minor Changes

- 77e2431: 新增 data-source 组件归因：dev 模式下为 JSX host 元素注入 data-agentlens-source="文件:行号" 属性，DOM 节点可直接回溯到渲染它的源码位置
- 安全与健壮性修复（全量代码审计产出）：

  - **安全**：daemon 的 WebSocket 摄取端口现在只绑定 `127.0.0.1`，局域网内其他机器不再能注入伪造事件或截获布局快照
  - **修复**：事件的 `url` 改为惰性读取，SPA 路由跳转后错误、日志等事件不再携带过期的初始 URL
  - **新增**：`navigation` 生命周期事件——runtime 通过补丁 History API 与监听 popstate/hashchange 上报 SPA 路由变化
  - **新增**：`unload` 生命周期事件——pagehide 时同步 flush，页面关闭/刷新前最后一批事件不再丢失
  - **修复**：错误折叠记录的 `sessionId` 跟随最新一次出现，页面 reload 后仍在复发的错误不再被会话过滤隐藏
  - **修复**：`Transport.close()` 现在先 flush 再关闭，dispose 时不丢批量窗口内的事件
  - **修复**：StackResolver 的 source map 缓存增加上限（默认 200 条 FIFO），长期运行的 daemon 在频繁 HMR 下内存不再无界增长
  - **重构**：`data-agentlens-source` 属性名收敛为 `@agentlensjs/shared` 导出的 `SOURCE_ATTRIBUTE` 常量（vite-plugin 原导出保持兼容）

### Patch Changes

- Updated dependencies
- Updated dependencies [bce576a]
- Updated dependencies [061e752]
  - @agentlensjs/shared@0.3.0

## 0.2.0

### Minor Changes

- 3db4280: 新增 verify_fix 修复验证闭环：错误事件暴露稳定指纹，runtime 经 Vite 插件上报 HMR 更新事件，daemon 提供 verify_fix 工具在代码更新后观察错误是否复现

### Patch Changes

- Updated dependencies [3db4280]
  - @agentlensjs/shared@0.2.0

## 0.1.0

### Minor Changes

- 5c5b292: 首个公开版本：错误/console/网络三类信号采集、sourcemap 源码级归因、错误去重折叠、会话隔离、传输层微批量，以及 `get_page_health` / `get_recent_events` / `list_sessions` 三个 MCP 工具

### Patch Changes

- Updated dependencies [5c5b292]
  - @agentlensjs/shared@0.1.0
