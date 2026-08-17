# hooks/ — Claude Code hook 接线

本目录给 Claude Code 提供 omd 纪律自动化接线。每个脚本都是独立可执行入口,
直接由 CC `settings.json` 的 `hooks` 数组调用。

> 脚本本身不动 `.ts`/`.md`/其他源文件:它们只读 stdin、判断、写 stdout/exit code。

---

## session-continuity.ts — Stop hook(冻结,W2 opt-in)

**作用**:会话跨 token 档时(默认 200k,env `OMD_SESSION_BUCKET` 可覆盖)输出
`decision: "block"` 拦下 Stop,让 Claude Code 续接一次;同档延续不重复触发。

### settings.json 接线

`Stop` hook 数组里挂这条,command 指向 bun 入口:

```json
{
  "hooks": {
    "Stop": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "bun run docs/examples/claude-code/hooks/session-continuity.ts"
          }
        ]
      }
    ]
  }
}
```

> hooks 目录下不存在 `ledger.ts` —— 落盘逻辑在 `src/harness/session/ledger.ts`,
> session-continuity.ts 经 `appendLedger` 调它(W2→W1 接缝)。

### 输入输出契约(一句话)

stdin 读 `{hook_event_name, stop_hook_active, writer_locked, transcript_path, session_id, cwd}` → stdout 写 `{}` 或 `{decision:"block", reason}`;**token bucket 唯一主触发**,`stop_hook_active: true` / `writer_locked: true` 两道守卫命中即不决策,**fail-open**:空 ledger / 缺 token / 阈值坏配置 / 输入不可读 → 全不决策、零写入、零抛错。

### 关键不变量(逐字来源 session-continuity.ts 头注)

- **opt-in 事件门**:仅 `hook_event_name === 'Stop'` 决策;SessionStart / PreCompact /
  SessionEnd / 缺省事件一律不决策。
- **守卫不是触发**:`stop_hook_active === true`(CC loop guard 防递归)、
  `writer_locked === true`(writer 双写排除)→ 不决策。
- **跨档一次性**:只比较最新两条 entry —— 最新 `tokenBucket ≥ 阈值` 且(无更早 entry 或
  前一条 < 阈值)→ block;前一条已 ≥ 阈值 = 同档延续,放行。
- **token 公式**(W3 stop-ledger.ts 冻结):`input + cache_read + cache_creation`,
  output 不计;三键任一缺/非有限 → `null` → 该 entry 不决策。
- **fail-open 零阻断**:解析失败 / 锁占用超时 / ledger 含坏行 → 仅 stderr 提示,
  决策照常输出空对象。

---

## ledger.jsonl 落盘位置

`appendLedger` 写到 `<projectRoot>/<scope.dataPath>/session/<sessionId>/ledger.jsonl`,
逐字对齐 `src/harness/session/writer.ts:351,367` 的 W1 尾读路径:

- writer 解析: `contDir = resolve(projectRoot, scope.dataPath(join('session', sessionId)))`
  (writer.ts:351)。
- writer 尾读: `readFileSync(join(contDir, 'ledger.jsonl'), …)` (writer.ts:367),只认
  `typeof j.ctxTokens === 'number'` 的行(serializer 在 ledger.ts 把 `tokenBucket`
  映射为 `ctxTokens`,I-5 该映射只许发生在这里)。
- 写者标识 `owner: "W2:session-continuity"`(`LEDGER_OWNER_W2`,W2 当前唯一生产调用方)。
- offset 去重 + `ledger.jsonl.lock` O_EXCL 锁防并发双写。

**关系一句话**:session-continuity.ts 把本轮记账 append 到 ledger.jsonl,W1 writer
启动时尾读同一文件拿到最新上下文 token 数;两者路径必须字面对齐,否则 writer 永远读不到。

---

## 其他三个 hook 脚本

- `verify-after-edit.sh` — PreToolUse hook:对 Write/Edit/MultiEdit 写 `.ts`/`.js`/
  `test/*`/`src/*` 触发 `bunx tsc --noEmit` + `bun test --bail`,失败 exit 2 硬拦。
- `dangerous-cmd.sh` — PreToolUse hook:拦截 `rm -rf` / `git push --force` /
  `git reset --hard` / `curl|sh` / `DROP|TRUNCATE|DELETE FROM` / `.env|.git/config` 重定向
  / `chmod 777`,exit 2 硬拦;`git checkout .` / `git clean -f` 仅 warning 放行。
- `memory-distill.sh` — Stop hook:会话结束往 stdout 打印一条软提示,引导模型用
  `memory_remember` MCP 工具存"一条可复用结论",exit 0 永拦截,advisory only。

---

## 接线总览

| hook | 事件 | 工具/触发 | 阻断语义 |
| --- | --- | --- | --- |
| session-continuity.ts | Stop | token 跨档 | `decision: "block"`(同档放行) |
| verify-after-edit.sh | PreToolUse | Write/Edit 写源/测 | exit 2 = 硬拦 |
| dangerous-cmd.sh | PreToolUse | Bash 命令分类 | exit 2 = 硬拦 |
| memory-distill.sh | Stop | 会话结束 | exit 0 = 软提示,永不拦 |

## 待确认

- hooks 目录下是否存在 `ledger.ts`:**无**。本 README 把 session-continuity.ts 引用
  的 `src/harness/session/ledger.ts` 当作"hook 的落盘后端"描述;若将来 hooks 目录新增
  独立 ledger 脚本,需同步更新本文。
- `writer_locked` 字段在 CC 标准 Stop 输入里是否存在:**未在 session-continuity.ts
  头注之外的源码里追到**,按现有契约照搬描述;若上游 CC 不下发该字段,守卫等价于永远
  不命中(行为不变,fail-open 安全)。
