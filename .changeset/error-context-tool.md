---
'@agentlensjs/mcp-server': minor
---

feat: 新增 get_error_context 工具——错误根因上下文聚合，一次调用返回折叠错误记录（含 source map 还原堆栈）、最近一次发生之前的用户交互（带源码归因）、同时间窗内的网络请求与控制台警告、会话 Web Vitals 画像；支持按 fingerprint 或事件 id 引用，默认取最近错误，lookbackMs 可配置追溯窗口；聚合前按时间戳显式排序，不依赖存储插入序
