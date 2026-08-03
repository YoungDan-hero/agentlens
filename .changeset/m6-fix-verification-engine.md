---
'@agentlensjs/shared': minor
'@agentlensjs/runtime': minor
'@agentlensjs/mcp-server': minor
'@agentlensjs/vite-plugin': minor
---

feat: M6 修复验证引擎——会话聚焦信号、反向源码查询、批量动作序列与一键错误回放

- **会话聚焦信号**：runtime 在每次连接建立与可见性/聚焦变化时上报 `focus-update`，daemon 选择快照/动作目标会话时优先聚焦页面（聚焦 > 可见 > 状态未知 > 后台），`list_sessions` 返回每个会话的实时 `connected` / `visible` / `focused` 状态——多标签页时 Agent 操作的是用户眼前的页面
- **反向源码查询**：新增 `find_elements_by_source` 工具，列出某个源码文件（`src/App.vue` 或精确 `src/App.vue:42`）当前在页面上渲染的所有元素；`get_recent_events` 新增 `source` 过滤（匹配元素交互、解析后错误堆栈与请求发起方，兼容相对/绝对/仅文件名三种 sourcemap 路径风格）
- **批量动作序列**：新增 `perform_actions` 工具与 `action-sequence-request/result` 协议，一次往返顺序执行最多 20 步动作；每步可声明 `waitFor` 本地等待条件（visible / attached / hidden + 超时），运行时在浏览器内轮询，异步 UI 无需 Agent 往返；遇失败或用户接管立即停止并报告断点（`stoppedAt` / `stopReason`）、每步结果与累计效果；`navigate` 仅允许作为最后一步
- **一键错误回放**：新增 `replay_error_path` 工具，把错误发生前的真人交互（过滤合成交互）推导成动作序列脚本；默认 dry run 供审阅，输入步骤因输入值从不采集而标记 `needsValue` 由调用方补值；执行后对比错误指纹发生次数并返回 `errorRecurred`——修复验证一条命令闭环
