---
name: dream
description: 记忆整理(同步):经 omd dream_consolidate 把近期事件窗压缩进 L0–L6 记忆层,产层计数统计。Trigger:/dream、记忆整理、巩固记忆、consolidate memory。
---

# /dream — 记忆整理

对应 omd 的 dream 巩固管线。经 omd MCP 的 `dream_consolidate`(可能带 `mcp__omd__` 前缀;未加载先 ToolSearch "dream_consolidate")把近期事件窗口里的洞察归并进七层记忆(L0–L6:durable fact 带 namespace/confidence,候选洞察按层落位)。

## 用法

无参数。适合:长会话收尾、一批任务完成后、owner 说"整理一下记忆"时。

## 流程(同步,慢)

`dream_consolidate()` **直接同步返回**,不走 runId 三段式——但它慢(要过模型),调用后耐心等结果,别超时重发(重复整理 = 重复烧模型调用)。空窗口不会调模型,直接回"无可整理"。

## 返回

整理统计:各层新增/更新的计数。转述给 owner 时按层讲"巩固了什么类型的洞察",有 namespace 冲突或低置信候选要提示人工过目。
