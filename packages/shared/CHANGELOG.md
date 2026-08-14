# @agentlensjs/shared

## 0.8.0

### Minor Changes

- 90a9e4e: feat: M6 修复验证引擎——会话聚焦信号、反向源码查询、批量动作序列与一键错误回放

  - **会话聚焦信号**：runtime 在每次连接建立与可见性/聚焦变化时上报 `focus-update`，daemon 选择快照/动作目标会话时优先聚焦页面（聚焦 > 可见 > 状态未知 > 后台），`list_sessions` 返回每个会话的实时 `connected` / `visible` / `focused` 状态——多标签页时 Agent 操作的是用户眼前的页面
  - **反向源码查询**：新增 `find_elements_by_source` 工具，列出某个源码文件（`src/App.vue` 或精确 `src/App.vue:42`）当前在页面上渲染的所有元素；`get_recent_events` 新增 `source` 过滤（匹配元素交互、解析后错误堆栈与请求发起方，兼容相对/绝对/仅文件名三种 sourcemap 路径风格）
  - **批量动作序列**：新增 `perform_actions` 工具与 `action-sequence-request/result` 协议，一次往返顺序执行最多 20 步动作；每步可声明 `waitFor` 本地等待条件（visible / attached / hidden + 超时），运行时在浏览器内轮询，异步 UI 无需 Agent 往返；遇失败或用户接管立即停止并报告断点（`stoppedAt` / `stopReason`）、每步结果与累计效果；`navigate` 仅允许作为最后一步
  - **一键错误回放**：新增 `replay_error_path` 工具，把错误发生前的真人交互（过滤合成交互）推导成动作序列脚本；默认 dry run 供审阅，输入步骤因输入值从不采集而标记 `needsValue` 由调用方补值；执行后对比错误指纹发生次数并返回 `errorRecurred`——修复验证一条命令闭环

## 0.7.0

### Minor Changes

- ed84776: feat: 新增浏览器动作通道（M5b）——Agent 可在用户真实开发会话内执行自动化测试。协议层新增 ActionRequest/ActionResult 消息与 InteractionEvent.synthetic 审计标记；runtime 新增动作执行器：三级元素定位（data-agentlens-source → CSS 选择器 → 可见文本最深匹配，nth 消歧）、合成事件派发按真实浏览器顺序 pointerdown → mousedown → focus → pointerup → mouseup → click（pointer 事件兼容 Radix / Headless UI 等监听 onPointerDown 的组件库，focus 对齐 Playwright 语义；原型 setter 写入兼容 React 受控组件，input+change 事件兼容 Vue v-model，HTMLElement.click 触发真实激活行为）、页面静默判定（settle）与动作副作用统计（错误/失败请求/控制台错误）、目标元素高亮描边；安全模型：allowActions 默认关闭需显式开启、用户 1.5 秒内有真实输入时拒绝执行（真人优先）、同时只执行一个动作、导航仅限同源、每个合成交互带 synthetic: true 入库留痕；mcp-server 新增 perform_action 与 wait_for_idle 两个 MCP 工具（工具总数 8 → 10）；vite-plugin 透传 allowActions 选项

## 0.6.0

### Minor Changes

- 9f44905: fix: 修复代码审查发现的三处缺陷并清理冗余代码——redactUrl 现在对 search 与 hash 两段 query 独立脱敏（修复 SSO 回调落在 hash 路由页时 hash 内敏感参数泄漏）、resolveStacks 增加异常兜底（防止损坏的 sourcemap 触发 unhandled rejection 杀死守护进程）、折叠错误复发时重新插入到事件数组最新位置（保证 get_recent_events 默认窗口不会漏掉仍在复发的老错误）、移除已被 zod 深校验取代的 isAgentLensEvent 浅校验导出

## 0.5.1

### Patch Changes

- df03e30: docs: 包级 README 同步 0.5.0 能力——补充 get_performance 工具、性能/WebSocket/sendBeacon 采集、captureBodies 选项与隐私说明

## 0.5.0

### Minor Changes

- 902b42e: feat: 性能采集、网络捕获补全与敏感数据脱敏

  - 新增 performance 事件与 `get_performance` MCP 工具：基于原生 PerformanceObserver 采集 Web Vitals（FCP/LCP/CLS/INP/TTFB，附 web.dev 评级）与长任务，零额外依赖
  - 网络捕获补全：新增 WebSocket 连接（成功/失败）与 sendBeacon 调用拦截，NetworkEvent 增加 transport 判别字段
  - 请求/响应体捕获（opt-in）：插件/运行时新增 `captureBodies` 选项，body 经敏感字段脱敏（password/token/secret/authorization 等替换为 [REDACTED]）并限长 4KB 后才发出
  - 隐私加固：所有网络事件的 URL 敏感查询参数默认擦除；请求头从设计上永不采集；beacon 事件不再被健康摘要误计为失败请求

## 0.4.0

### Minor Changes

- 12ad090: 网络采集新增 `XMLHttpRequest` 拦截：通过 patch `open`/`send` 原型方法并监听 `loadend`，捕获方法、URL、状态码、耗时与发起方堆栈。axios 默认浏览器适配器等基于 XHR 的请求库现在同样被完整记录；状态码 0（网络失败 / 超时 / 中止）归一为 `null` 状态与 fetch 侧语义对齐。其余包同步升版保持版本对齐

## 0.3.0

### Minor Changes

- 安全与健壮性修复（全量代码审计产出）：

  - **安全**：daemon 的 WebSocket 摄取端口现在只绑定 `127.0.0.1`，局域网内其他机器不再能注入伪造事件或截获布局快照
  - **修复**：事件的 `url` 改为惰性读取，SPA 路由跳转后错误、日志等事件不再携带过期的初始 URL
  - **新增**：`navigation` 生命周期事件——runtime 通过补丁 History API 与监听 popstate/hashchange 上报 SPA 路由变化
  - **新增**：`unload` 生命周期事件——pagehide 时同步 flush，页面关闭/刷新前最后一批事件不再丢失
  - **修复**：错误折叠记录的 `sessionId` 跟随最新一次出现，页面 reload 后仍在复发的错误不再被会话过滤隐藏
  - **修复**：`Transport.close()` 现在先 flush 再关闭，dispose 时不丢批量窗口内的事件
  - **修复**：StackResolver 的 source map 缓存增加上限（默认 200 条 FIFO），长期运行的 daemon 在频繁 HMR 下内存不再无界增长
  - **重构**：`data-agentlens-source` 属性名收敛为 `@agentlensjs/shared` 导出的 `SOURCE_ATTRIBUTE` 常量（vite-plugin 原导出保持兼容）

- bce576a: 新增交互时间线：runtime 采集点击、输入（去抖）、表单提交等用户交互并携带目标元素源码归因，daemon 提供 get_interaction_timeline 工具将错误、请求、日志归组到触发它们的交互之下，形成因果链视图
- 061e752: 新增 get_layout_snapshot 结构化布局快照：daemon 经 WebSocket 反向请求浏览器采集精简盒模型树（尺寸、可见性、溢出、文本），每个节点携带 data-source 源码归因，AI 无需截图即可推理页面布局

## 0.2.0

### Minor Changes

- 3db4280: 新增 verify_fix 修复验证闭环：错误事件暴露稳定指纹，runtime 经 Vite 插件上报 HMR 更新事件，daemon 提供 verify_fix 工具在代码更新后观察错误是否复现

## 0.1.0

### Minor Changes

- 5c5b292: 首个公开版本：错误/console/网络三类信号采集、sourcemap 源码级归因、错误去重折叠、会话隔离、传输层微批量，以及 `get_page_health` / `get_recent_events` / `list_sessions` 三个 MCP 工具
