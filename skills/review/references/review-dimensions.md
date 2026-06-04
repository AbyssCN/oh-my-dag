# Code Review Dimensions (A-I) -- Full Reference

> Extracted from the code-review board for detailed dimension checklists.
> The summary table is in the main `/review` SKILL.md.

---

## A) Multi-tenant isolation (company boundary)

- Every query path is tenant-scoped
- No cross-tenant read/write
- Service role usage justified and guarded

## B) RLS & authorization correctness

- RLS exists for every business table
- Policies cover SELECT/INSERT/UPDATE/DELETE appropriately
- No "bypass" from client-side logic

## C) Domain invariants

- Distinct domain concepts are not conflated (e.g. raw event != derived record != billable insight)
- Edits/overrides do not corrupt the audit trail

## D) Auditability & traceability

- Creation/modification attribution recorded
- Status transitions auditable
- Sensitive admin actions logged

## E) Data migrations & backwards compatibility

- Migrations are safe (expand/contract strategy)
- An old app version should not break during rollout

## F) Reliability & UX states

- Handles empty/loading/error/offline/permission-denied states

---

## G) Next.js & Vercel Best Practices — ⚠ Web UI ONLY (dormant for daemon-only projects)

> This section applies only when a project has a Next.js/React/Vercel web UI. For a Bun/Hono (or similar) daemon with no web frontend, skip it and use §A-F plus a daemon-architect lens (loop blocking / tick CAS / WS lifecycle).

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

### Next.js Features (verify in new code)

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

---

## H) Cross-layer Contract Verification (B1-B4) — ⚠ web-app shape; partially applies to a daemon

> This section's B1-B4 is a SaaS web-app contract framework (RLS / DB query/RPC actions / frontend consume). A daemon side typically only needs **B1 Schema↔RLS consistency** if it has an ORM + PG RLS; B2/B3/B4 (Action/Frontend) don't apply. The cross-layer contract **concept** stays a methodology core, but the automated checkers below are web-app-only — a daemon relies on manual review + cross-model adversarial review.

Identifier verification across architecture-layer boundaries (INV-1 ~ INV-4) — conceptual reference; automation not ported.

### B1: Schema -> RLS (INV-1 Ref-Resolution)

- RLS USING/WITH CHECK expressions reference columns that exist in the table schema
- RLS policies cover all required CRUD operations
- Portal vs internal policy isolation correct
- CI: contract B1 check (blocking)

### B2: Schema/View -> Action (INV-1 + INV-4)

- `.from('table').select('fields')` fields exist in the table/view schema
- `.rpc()` parameter names and types match the SQL definition
- View/RPC return structure matches action consumption
- CI: contract B2 check (advisory -- relation queries cause false positives)

### B3: Action -> Frontend (INV-4 Produce->Consume)

- Handler return fields match consumer (channel/WS/event) destructuring (`data.fieldName`)
- Status enum values aligned between action and UI
- Error handling path covers `ActionResponse.success === false`
- Agent: boundary-b3-checker (semantic verification)

### B4: Frontend -> Action (INV-2 Path-Completeness)

- All write functions have schema input validation
- No `...input` spread without field whitelist
- Drag/batch/form operations all pass the same validation path
- CI: contract B4 check (advisory)

### INV-3: Constraint Consistency (cross-cutting)

- DB CHECK constraints consistent with validation rules
- State machine transitions match DB/RLS constraints
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

- ⚠ The contract-check CI script is web-app-only — a daemon does cross-layer contracts via manual + adversarial review
- Framework: the cognitive-architecture INV-1..8 concepts

---

## I) Test Sufficiency

Checks that tests cover critical boundaries, not just the happy path:

- [ ] Every new/modified action has a corresponding `*.test.ts`?
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
6. Web best-practices checker reports **errors** (not warnings/info)
7. Missing `'use server'` in action files
8. Performance regression >10% from baseline
9. Contract B1 check fails (RLS references non-existent columns)
10. Write function lacks input validation with no justification
