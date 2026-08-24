---
skill_id: skill-with-check
skill_version: 1.0.0
---

# skill-with-check

This skill drafts a short prose summary for a topic the caller passes in. The
caller supplies a `topic` (string, required) and optionally a `tone` (one of
`neutral`, `friendly`, `terse`). Output is a single paragraph of plain prose,
no bullet lists, no headings.

## What this skill does

Given a topic, produce a paragraph that:

- Names the topic in the first sentence.
- Stays within roughly 60–120 words.
- Uses the requested `tone`. When `tone` is omitted, default to `neutral`.
- Avoids filler openers ("In conclusion", "Overall") and avoids second-person
  address ("you", "your").

## Constraints enforced by checks

The mechanical constraints below are not enforced by this prose. They are
enforced by the script listed in `checks[]` of the manifest:

- Word count stays inside the requested band.
- The first sentence contains the topic string verbatim.
- The output contains no markdown of any kind (no `#`, no `-`, no backticks).
- No second-person pronouns appear in the body.

If a check script flags a violation, the plan that referenced this skill fails
its post-leaf gate and surfaces the diagnostic verbatim. Fix the output and
re-run; this skill does not retry on its own.

## Inputs

| name   | type   | required | notes                                       |
|--------|--------|----------|---------------------------------------------|
| topic  | string | yes      | quoted or single-word; verbatim in sentence |
| tone   | enum   | no       | `neutral` (default) / `friendly` / `terse`  |

## Output

A single paragraph of plain prose. No preamble, no closing line, no
trailing newline beyond the final period.
