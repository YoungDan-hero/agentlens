# @agentlensjs/vite-plugin

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
