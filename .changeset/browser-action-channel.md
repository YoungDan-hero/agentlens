---
'@agentlensjs/shared': minor
'@agentlensjs/runtime': minor
'@agentlensjs/mcp-server': minor
'@agentlensjs/vite-plugin': minor
---

feat: 新增浏览器动作通道（M5b）——Agent 可在用户真实开发会话内执行自动化测试。协议层新增 ActionRequest/ActionResult 消息与 InteractionEvent.synthetic 审计标记；runtime 新增动作执行器：三级元素定位（data-agentlens-source → CSS 选择器 → 可见文本最深匹配，nth 消歧）、合成事件派发按真实浏览器顺序 pointerdown → mousedown → focus → pointerup → mouseup → click（pointer 事件兼容 Radix / Headless UI 等监听 onPointerDown 的组件库，focus 对齐 Playwright 语义；原型 setter 写入兼容 React 受控组件，input+change 事件兼容 Vue v-model，HTMLElement.click 触发真实激活行为）、页面静默判定（settle）与动作副作用统计（错误/失败请求/控制台错误）、目标元素高亮描边；安全模型：allowActions 默认关闭需显式开启、用户 1.5 秒内有真实输入时拒绝执行（真人优先）、同时只执行一个动作、导航仅限同源、每个合成交互带 synthetic: true 入库留痕；mcp-server 新增 perform_action 与 wait_for_idle 两个 MCP 工具（工具总数 8 → 10）；vite-plugin 透传 allowActions 选项
