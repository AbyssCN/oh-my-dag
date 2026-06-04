# Code Review Dimensions (A-I) -- Full Reference

> Extracted from code-review-board for detailed dimension checklists.
> Summary table is in the main `/review` SKILL.md.

---

## A) Multi-tenant isolation (company boundary)

- Every query path is tenant-scoped
- No cross-company read/write
- Service role usage justified and guarded

## B) RLS & authorization correctness

- RLS exists for every business table
- Policies cover SELECT/INSERT/UPDATE/DELETE appropriately
- No "bypass" from client-side logic

## C) Domain invariants

- attendance != work entry != billing insight
- Edits/overrides do not corrupt audit trail

## D) Auditability & traceability

- Creation/modification attribution recorded
- Status transitions auditable
- Sensitive admin actions logged

## E) Data migrations & backwards compatibility

- Migrations are safe (expand/contract strategy)
- Old app version should not break during rollout

## F) Reliability & UX states

- Handles empty/loading/error/offline/permission denied states

---

## G) Next.js & Vercel Best Practices — ⚠ Phase 4+ Web UI ONLY (dormant)

> **valinor 是 Bun/Hono daemon, 无 Next.js/React/Vercel** — 本节仅在 Phase 4+ `ai.example.com` Web UI 真建时激活 (D52, 大概率 Next.js)。当前 daemon review 用 §A-F + stack-architect daemon lens (loop 阻塞 / tick CAS / WS 生命周期)。**无 `npm run check:vercel`** (valinor 不存在该 script)。

### 5 Critical Rules (enforced by automated checker)

#### 1. Server Components by default
- No unnecessary `'use client'` directives
- Data fetching in Server Components
- Check: Component uses client-side hooks/events?

#### 2. Server Actions for mutations
- No client-side `fetch()` for POST/PUT/DELETE
- `'use server'` directive in action files
- Check: All mutations use Server Actions?

#### 3. Error boundaries
- No missing `error.tsx` for route segments
- Route-level and component-level boundaries
- Check: Fallback UI for errors?

#### 4. Image optimization
- No `<img>` instead of `next/image`
- No missing width/height on Image components
- Using `next/image` with proper sizing
- Check: Priority flag for above-the-fold images?

#### 5. Code splitting
- No heavy libraries imported directly
- Dynamic imports for heavy components
- Check: Recharts, @tanstack/react-table, react-pdf?

### Next.js 2026 Features (verify in new code)

- [ ] Uses `after()` for non-blocking side effects (audit logs, analytics)
- [ ] Implements Partial Prerendering (PPR) where applicable
- [ ] Uses Suspense boundaries for streaming
- [ ] Implements selective hydration for interactive islands

### Performance Budget (Lighthouse CI enforced)

| Metric | Budget |
| ------ | ------ |
| FCP    | <= 1.8s |
| LCP    | <= 2.5s |
| TBT    | <= 300ms |
| CLS    | <= 0.1  |

<!-- References (check-vercel-best-practices.mjs / npm run check:vercel) 已删 2026-06-01: valinor 无该 script (the sibling project webapp only)。本节 dormant, 激活时再补 checker。 -->

---

## H) Cross-layer Contract Verification (B1-B4) — ⚠ the sibling project 形态, valinor daemon 部分适用

> **valinor 校正 (2026-06-01)**: 本节 B1-B4 是 the sibling project SaaS-webapp 契约框架 (RLS / Supabase `.from().select()`/`.rpc()` Action / Next.js Frontend consume)。**无 `check-contracts.mjs` / `npm run check:contracts`** (valinor 不存在, 且用 Bun)。daemon 侧仅 **B1 Schema↔RLS 一致性** 部分适用 (valinor 有 Drizzle+PG RLS, 见 sql/*.sql + tenant_id); B2/B3/B4 (Action/Frontend) 不适用。跨层契约**概念**仍是 Core4 §3 方法论核心, 但下方自动化 checker 是 the sibling project, valinor 走人工 + Codex G2 review。

跨架构层边界的 identifier 验证 (INV-1 ~ INV-4) — 概念参考, 自动化未移植。

### B1: Schema -> RLS (INV-1 Ref-Resolution)

- RLS USING/WITH CHECK expressions reference columns that exist in table schema
- RLS policies cover all required CRUD operations
- Portal vs internal policy isolation correct
- CI: `check:contracts` B1 check (blocking)

### B2: Schema/View -> Action (INV-1 + INV-4)

- `.from('table').select('fields')` fields exist in table/view schema
- `.rpc()` parameter names and types match SQL definition
- View/RPC return structure matches Action consumption
- CI: `check:contracts` B2 check (advisory -- Supabase relation queries cause false positives)

### B3: Action -> Frontend (INV-4 Produce->Consume)

- Handler return fields match consumer (channel/WS/event) destructuring (`data.fieldName`)
- Status enum values aligned between Action and UI
- Error handling path covers `ActionResponse.success === false`
- Agent: `boundary-b3-checker` (semantic verification)

### B4: Frontend -> Action (INV-2 Path-Completeness)

- All write functions have Zod input validation
- No `...input` spread without field whitelist
- Drag/batch/form operations all pass same validation path
- CI: `check:contracts` B4 check (advisory)

### INV-3: Constraint Consistency (cross-cutting)

- DB CHECK constraints consistent with Zod validation rules
- State machine transitions (`state-machine.ts`) match DB/RLS constraints
- FK CASCADE does not silently delete business-critical data

### INV References

| INV   | Description              | Boundary |
| ----- | ------------------------ | -------- |
| INV-1 | Ref-Resolution           | B1, B2   |
| INV-2 | Path-Completeness        | B4       |
| INV-3 | Constraint Consistency   | Cross    |
| INV-4 | Produce->Consume         | B2, B3   |
| INV-5 | (reserved)               | --       |
| INV-6 | Dashboard auth guard     | Security |
| INV-7 | GET purity (no writes)   | Security |
| INV-8 | No exists:boolean leak   | Security |

### H References

- ⚠ CI script `scripts/check-contracts.mjs` — the sibling project, valinor 不存在 (跨层契约走人工 + Codex G2)
- Framework: `docs/standards/cognitive-architecture/FRAMEWORK.md` (INV-1..8 概念)

---

## I) Test Sufficiency

Checks that tests cover critical boundaries, not just happy-path:

- [ ] Every new/modified action has corresponding `*.test.ts`?
- [ ] Tests cover error paths (no permission / invalid input / DB failure)?
- [ ] Tests cover boundary values (empty list / single / large dataset)?
- [ ] New RPC/migration has corresponding integration verification?

### Scoring

| Condition                                    | Verdict          |
| -------------------------------------------- | ---------------- |
| All actions tested + error paths covered     | Pass             |
| Tests exist but only happy-path              | Request Changes (P1) |
| Critical action has no tests                 | Stop-ship (P0)   |

---

## Stop-ship Criteria (P0) -- Full List

Any of these findings results in a **stop-ship** verdict:

1. Tenant data leakage possibility
2. RLS missing on a business table
3. Service role used from client / exposed
4. Audit trail broken for status changes
5. Migration can cause data loss
6. Vercel checker reports **errors** (not warnings/info)
7. Missing `'use server'` in action files
8. Performance regression >10% from baseline
9. `check:contracts` B1 check fails (RLS references non-existent columns)
10. Write function lacks Zod validation with no justification
