# @agentlensjs/vite-plugin

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
