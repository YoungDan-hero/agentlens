---
'@agentlensjs/vite-plugin': minor
---

feat: Vue 一等公民支持——新增基于 @vue/compiler-dom 的 SFC 模板源码归因注入器，为模板中的原生元素自动打上 data-agentlens-source="文件:行号"（组件标签与 template/slot 包装不注入，支持插槽内容递归、跳过 pug/外部模板与 ?raw/?url 资产请求、容忍编辑中的可恢复解析错误），交互时间线与布局快照在 Vue 项目中同样可以追溯到源码行；同时修复 CJS 产物中 magic-string 的 ESM interop 崩溃（改用具名导入，require() 加载插件的项目此前一旦命中注入路径即报 "not a constructor"）
