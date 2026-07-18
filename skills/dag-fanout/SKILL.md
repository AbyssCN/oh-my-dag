---
name: dag-fanout
tier: core
runtime: on-demand
trigger: mention
description: "Hand-written lens-spec fanout: you author the lenses (persona + sub-angles), the engine runs them concurrently and judges. Manual gearbox of dag-council. Trigger: fanout with my own lenses / 手写 lens / 我已明确要哪几个视角 / dag-fanout. Skip: want the conductor to author lenses automatically (/dag-council, the default) / web research (/dag-research)."
metadata:
  source: oh-my-dag
  version: "1.0.0"
  methodology: "explicit lens spec + diversity>volume + multi-judge panel"
---
# /dag-fanout — hand-written lens fanout

When you already know exactly which expert perspectives you want, write them down and
skip the conductor: each lens (persona + V sub-angles) runs concurrently over the same
question + ground truth, then reduce → synthesis → judge.

## Usage

```bash
bun run dag-fanout <spec.json>
```

```jsonc
// spec.json
{
  "question": "…",
  "groundTruth": "…",                     // shared evidence base fed to every lens
  "lenses": [
    { "key": "operator", "persona": "…", "subAngles": ["…", "…"] },
    { "key": "risk",     "persona": "…", "subAngles": ["…"] }
  ],
  "synthesisFramings": ["…"],             // optional
  "judgeCriteria": ["…"],                 // optional; default includes factual/engineering correctness
  "lensModel": "provider:model",          // optional (env OMD_LENS_MODEL)
  "reasonModel": "provider:model"         // optional (env OMD_REASON_MODEL)
}
```

Artifact: `/tmp/dag-fanout-<slug>-<ts>.md`.

## Discipline

Diversity > volume: sub-angles must be **different questions**, not the same prompt
resampled — resampling has diminishing returns; orthogonal angles don't.
