---
'@agentlensjs/shared': minor
'@agentlensjs/runtime': minor
'@agentlensjs/mcp-server': minor
'@agentlensjs/vite-plugin': minor
---

feat: 性能采集、网络捕获补全与敏感数据脱敏

- 新增 performance 事件与 `get_performance` MCP 工具：基于原生 PerformanceObserver 采集 Web Vitals（FCP/LCP/CLS/INP/TTFB，附 web.dev 评级）与长任务，零额外依赖
- 网络捕获补全：新增 WebSocket 连接（成功/失败）与 sendBeacon 调用拦截，NetworkEvent 增加 transport 判别字段
- 请求/响应体捕获（opt-in）：插件/运行时新增 `captureBodies` 选项，body 经敏感字段脱敏（password/token/secret/authorization 等替换为 [REDACTED]）并限长 4KB 后才发出
- 隐私加固：所有网络事件的 URL 敏感查询参数默认擦除；请求头从设计上永不采集；beacon 事件不再被健康摘要误计为失败请求
