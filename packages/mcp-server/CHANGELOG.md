# @agentlensjs/mcp-server

## 0.4.0

### Minor Changes

- 12ad090: 网络采集新增 `XMLHttpRequest` 拦截：通过 patch `open`/`send` 原型方法并监听 `loadend`，捕获方法、URL、状态码、耗时与发起方堆栈。axios 默认浏览器适配器等基于 XHR 的请求库现在同样被完整记录；状态码 0（网络失败 / 超时 / 中止）归一为 `null` 状态与 fetch 侧语义对齐。其余包同步升版保持版本对齐

### Patch Changes

- Updated dependencies [12ad090]
  - @agentlensjs/shared@0.4.0

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
