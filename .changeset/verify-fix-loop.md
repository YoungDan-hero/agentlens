---
'@agentlensjs/shared': minor
'@agentlensjs/runtime': minor
'@agentlensjs/vite-plugin': minor
'@agentlensjs/mcp-server': minor
---

新增 verify_fix 修复验证闭环：错误事件暴露稳定指纹，runtime 经 Vite 插件上报 HMR 更新事件，daemon 提供 verify_fix 工具在代码更新后观察错误是否复现
