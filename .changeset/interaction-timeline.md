---
'@agentlensjs/shared': minor
'@agentlensjs/runtime': minor
'@agentlensjs/mcp-server': minor
---

新增交互时间线：runtime 采集点击、输入（去抖）、表单提交等用户交互并携带目标元素源码归因，daemon 提供 get_interaction_timeline 工具将错误、请求、日志归组到触发它们的交互之下，形成因果链视图
