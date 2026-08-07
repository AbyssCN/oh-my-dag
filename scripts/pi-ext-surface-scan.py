#!/usr/bin/env python3
"""
pi extension API 触碰面 —— **静态**体检(2026-08-07)。

⚠ 只读源码, **一行都不执行** —— 用执行去测量"该不该防执行"是把顺序搞反了。
代价是精度: 正则会误报同名成员(一个包自己的 `.model` 也会命中), 所以
「阻塞项」那一列刻意只统计**名字独特、不会撞车**的那几个。
"""
import json, os, re, sys
from collections import defaultdict

ROOT = "/tmp/extprobe/pkgs/x"

# pi ExtensionAPI 的 33 个事件(逐字来自 types.d.ts)
EVENTS = """project_trust resources_discover session_start session_info_changed session_before_switch
session_before_fork session_before_compact session_compact session_shutdown session_before_tree
session_tree context before_provider_request before_provider_headers after_provider_response
before_agent_start agent_start agent_end agent_settled turn_start turn_end message_start
message_update message_end tool_execution_start tool_execution_update tool_execution_end
model_select thinking_level_select tool_call tool_result user_bash input""".split()

# 我们**打算实现**的子集(纯数据 / 可序列化渲染)
IMPLEMENTABLE_API = """registerTool registerCommand appendEntry registerEntryRenderer
registerMessageRenderer registerMarkdownTransformer registerFlag getFlag getCommands
getActiveTools getAllTools setActiveTools getSessionName getThinkingLevel""".split()

# ⚠ 第一版把这些全算「阻塞」—— **量了子面之后发现基本是错的**。重新分三桶:
#
# A. 真的没有对应物(omd 没有会话树/分支这个概念)
# ⚠ 第二版把 getBranch 也算进来了 —— **也是错的**。读了 pi 的定义:
#   `ctx.sessionManager` 的类型是 `ReadonlySessionManager`(15 个只读方法的 Pick<>, 不能改宿主),
#   而 `getBranch(fromId?): SessionEntry[]` = 从根到当前叶的条目列表。
#   omd 的会话是**线性**的 —— 那就是消息数组本身, 是树退化成一条线, 不是没有这个概念。
BLOCKING = """fork navigateTree parentSession withSession""".split()
#
# B. 有对应物, 要写适配层(不是从零)
ADAPTABLE = """switchSession newSession summarize triggerTurn sendUserMessage registerShortcut
replaceInstructions getSessionId getCwd getSessionName getEntries getSessionFile getBranch
getAvailable getAll find hasConfiguredAuth""".split()
#
# C. ⚠ **安全决策不是技术问题**: 把 API key 交给扩展, 与沙箱的目的直接冲突
SECURITY = """getApiKeyAndHeaders""".split()

# 对话框 UI —— omd 一个都没建, 但 pi-tui 有 SelectList + SDD §7.1 有做法
UI_CALLS = "ui.select ui.confirm ui.input ui.notify".split()

def sources(pkgdir):
    for base, _dirs, files in os.walk(pkgdir):
        if "node_modules" in base:
            continue
        for f in files:
            if f.endswith((".ts", ".js", ".mjs", ".cjs")) and not f.endswith(".d.ts"):
                yield os.path.join(base, f)

rows = []
for pkg in sorted(os.listdir(ROOT)):
    text = []
    for p in sources(os.path.join(ROOT, pkg)):
        try:
            text.append(open(p, encoding="utf-8", errors="ignore").read())
        except OSError:
            pass
    src = "\n".join(text)
    if not src:
        rows.append({"pkg": pkg, "empty": True})
        continue
    ev = sorted({e for e in EVENTS if re.search(r'on\(\s*["\']' + re.escape(e) + r'["\']', src)})
    api = sorted({m for m in IMPLEMENTABLE_API if re.search(r"\." + re.escape(m) + r"\s*\(", src)})
    blk = sorted({m for m in BLOCKING if re.search(r"\." + re.escape(m) + r"\b", src)})
    ada = sorted({m for m in ADAPTABLE if re.search(r"\." + re.escape(m) + r"\b", src)})
    sec = sorted({m for m in SECURITY if re.search(r"\." + re.escape(m) + r"\b", src)})
    ui = sorted({u for u in UI_CALLS if re.search(r"\." + re.escape(u.split(".")[1]) + r"\s*\(", src) and re.search(r"\bui\b", src)})
    rows.append({"pkg": pkg, "events": ev, "api": api, "blocking": blk, "adaptable": ada, "security": sec, "ui": ui, "empty": False})

if "--json" in sys.argv:
    print(json.dumps(rows, ensure_ascii=False, indent=2))
    sys.exit(0)

clean = [r for r in rows if not r["empty"] and not r["blocking"]]
blocked = [r for r in rows if not r["empty"] and r["blocking"]]
needs_ui = [r for r in rows if not r["empty"] and r["ui"]]
needs_key = [r for r in rows if not r["empty"] and r["security"]]

print(f"# pi extension API 触碰面(静态扫描,{len(rows)} 个包)\n")
print("| 包 | 事件 | 直接可实现 | 要适配层 | 对话框 | **真缺** | ⚠ 要 API key |")
print("|---|---|---|---|---|---|---|")
for r in rows:
    if r["empty"]:
        print(f"| {r['pkg']} | (无源码) | | | |")
        continue
    b = "、".join(r["blocking"]) or "—"
    u = "、".join(x.split(".")[1] for x in r["ui"]) or "—"
    sec = "是" if r["security"] else "—"
    print(f"| {r['pkg']} | {len(r['events'])} | {len(r['api'])} | {len(r['adaptable'])} | {u} | {b} | {sec} |")

print(f"\n**没有「真缺」的包(适配层写全就能装):{len(clean)} / {len(rows)}**")
print(f"**有「真缺」的(omd 没这个概念):{len(blocked)}** — " + "、".join(r["pkg"].split("-")[0] + ":" + "/".join(r["blocking"]) for r in blocked))
print(f"**要对话框 UI 的:{len(needs_ui)}**  **要 API key 的:{len(needs_key)}** — " + "、".join(r["pkg"] for r in needs_key))

hits = defaultdict(int)
for r in rows:
    for e in r.get("events", []):
        hits[e] += 1
print("\n## 事件热度(决定先实现哪几个)")
for e, n in sorted(hits.items(), key=lambda kv: -kv[1]):
    print(f"  {n:>2}x  {e}")
