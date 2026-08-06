# Pathfinder: fog 验收图 —— 七档雾各占一格(SDD 2026-08-06 §9.1;不是真项目,别派活)

<!-- slug: fog-acceptance -->

## Decisions so far

- [a-ruled] 裁了。这一格证明 clear 档。

## Tickets

### status: suggested

### d-suggested
- type: grill
- title: 机器建议:要不要给雾图加一个时间轴回放
- status: suggested
- blockedBy: 
- suggestedBy: run-fixture

### status: open

### b-frontier
- type: grill
- title: 前置已散尽 → frontier(现在就能派)
- status: open
- blockedBy: a-ruled
- children: child-not-yet

### e-near
- type: grill
- title: 还差一层 → near(浅雾,标题可读)
- status: open
- blockedBy: b-frontier

### f-deep
- type: grill
- title: 还差两层 → deep(深雾,只剩轮廓)
- status: open
- blockedBy: e-near

### g-dangling
- type: grill
- title: 前置 id 图上不存在 → unreachable/dangling(补票才动得了)
- status: open
- blockedBy: ghost-ticket

### h-cycle-1
- type: grill
- title: 环的一半 → unreachable/cycle(打断环才动得了)
- status: open
- blockedBy: h-cycle-2

### h-cycle-2
- type: grill
- title: 环的另一半 → unreachable/cycle
- status: open
- blockedBy: h-cycle-1

### status: blocked

_(none)_

### status: ruled

### a-ruled
- type: grill
- title: 已裁决的票 → clear
- status: ruled
- blockedBy: 
- ruling: 裁了。这一格证明 clear 档。

### status: delivered

### a-delivered
- type: grill
- title: 已交付的票 → clear(与 ruled 同档)
- status: delivered
- blockedBy: 
- ruling: 交付了。

### status: escalated

### c-escalated
- type: grill
- title: 这条路该走 A 还是 B?—— 需要 owner 拍板
- status: escalated
- blockedBy: 
