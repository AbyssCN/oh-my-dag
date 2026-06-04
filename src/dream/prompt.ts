/**
 * src/dream/prompt.ts — the Memory Restraint consolidation prompt (PLAN D57, R5 split).
 *
 * The instruction handed to the LIVE Dream model (D60). The deterministic
 * restraintGate (§3.5.1) enforces the same discipline mechanically so the daemon
 * never relies on the model obeying prose.
 *
 * R5 SPLIT (mirrors the safeguard): the **universal** base lives here in core and
 * is domain-free — it only knows how to learn about the USER (user.*) and the
 * agent ITSELF (valar.*). Domain extraction guidance (e.g. the a sibling project accountant's
 * intuition: Kirjanpitolaki / VAT / GDPR Art 9) is a **pack** the deployment
 * composes on at the boundary via {@link composeConsolidationPrompt}, exactly as
 * a sibling project is assembled onto the universal namespaces. A domain-free
 * deployment runs the universal base alone — it is never told to think like an
 * accountant.
 */

/**
 * Domain-free consolidation base. Extracts the durable facts about the user and
 * the agent itself; everything jurisdiction- or business-specific is a composed
 * overlay. Keeps the restraint discipline (DROP when unsure, NEVER record a
 * transcript) that the restraintGate also enforces.
 */
export const UNIVERSAL_CONSOLIDATION_PROMPT = `# Restraint rules (CRITICAL — you keep a few durable insights, NOT a transcript)

You consolidate raw events into a handful of facts worth carrying forward about
the USER you work with and about YOURSELF. The full record (messages, documents,
tool output) lives elsewhere — your job is the opposite: the 5-10 insights an
attentive colleague would actually remember, not a log.

EXTRACT about the user (user.* namespaces):
- Preferences — how they like things done ("wants bullets not prose", "review before sending")
- Interests / focus — topics they care about or are working on right now
- Expertise — what they are skilled at (and how deeply)
- Traits — values, working style, identity ("decides on evidence, not seniority")
- Goals — what they are trying to achieve, and the horizon

EXTRACT about yourself (valar.* namespaces):
- Capability — what you are good or weak at, self-assessed by experience (NOT a tool list)
- Pattern — what approach worked or failed in what situation (procedural learning)
- Limit — your hard constraints, boundaries, blind spots

NEVER extract (drop silently):
- Conversation content / pleasantries / small talk — it is not an insight
- Anything already recorded verbatim elsewhere — don't duplicate the source
- Sensitive personal information you were not meant to retain, or characterizations
  that would erode trust if remembered

If unsure whether a fact is useful → DROP it. A precise 10-fact memory beats a
noisy 1000-fact memory. Over-recording degrades retrieval, erodes trust, and
accumulates drift you'll have to clean up later.`;

/**
 * Compose the universal base with zero or more domain overlays into the single
 * prompt the live adapter prepends. The deployment passes its domain pack's
 * consolidation prompt (e.g. a sibling project) — parallel to
 * assembleSafeguard([USER, VALAR, a sibling project]). With no overlays the base stands alone.
 */
export function composeConsolidationPrompt(
  base: string,
  ...overlays: string[]
): string {
  return [base, ...overlays].join('\n\n---\n\n');
}
