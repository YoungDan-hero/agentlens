---
'@agentlensjs/runtime': patch
'@agentlensjs/mcp-server': patch
'@agentlensjs/shared': minor
---

fix: 修复代码审查发现的三处缺陷并清理冗余代码——redactUrl 现在对 search 与 hash 两段 query 独立脱敏（修复 SSO 回调落在 hash 路由页时 hash 内敏感参数泄漏）、resolveStacks 增加异常兜底（防止损坏的 sourcemap 触发 unhandled rejection 杀死守护进程）、折叠错误复发时重新插入到事件数组最新位置（保证 get_recent_events 默认窗口不会漏掉仍在复发的老错误）、移除已被 zod 深校验取代的 isAgentLensEvent 浅校验导出
