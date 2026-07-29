---
'@agentlensjs/runtime': minor
'@agentlensjs/shared': minor
'@agentlensjs/mcp-server': minor
'@agentlensjs/vite-plugin': minor
---

网络采集新增 `XMLHttpRequest` 拦截：通过 patch `open`/`send` 原型方法并监听 `loadend`，捕获方法、URL、状态码、耗时与发起方堆栈。axios 默认浏览器适配器等基于 XHR 的请求库现在同样被完整记录；状态码 0（网络失败 / 超时 / 中止）归一为 `null` 状态与 fetch 侧语义对齐。其余包同步升版保持版本对齐
