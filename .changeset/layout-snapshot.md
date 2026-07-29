---
'@agentlensjs/shared': minor
'@agentlensjs/runtime': minor
'@agentlensjs/mcp-server': minor
---

新增 get_layout_snapshot 结构化布局快照：daemon 经 WebSocket 反向请求浏览器采集精简盒模型树（尺寸、可见性、溢出、文本），每个节点携带 data-source 源码归因，AI 无需截图即可推理页面布局
