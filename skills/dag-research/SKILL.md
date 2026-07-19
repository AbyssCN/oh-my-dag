---
name: dag-research
tier: core
runtime: on-demand
trigger: mention
description: "Web research as a DAG: retrieve (multi-query search + tiered crawl) → multi-lens fanout → judged synthesis, one command, zero-loss corpus artifact. Trigger: research this / what is X and which is better / grounded answer from the web / 调研 / 查一下X怎么做 / 综合网上说法 / dag-research. Skip: you only need raw page content (fetch directly) / question answerable from the codebase (read code) / wide design decision without web grounding (/dag-council)."
metadata:
  source: oh-my-dag
  version: "1.0.0"
  methodology: "retrieve → lens fanout → judge; corpus fed to every lens; zero-loss artifact appendix"
disable-model-invocation: true
---
# /dag-research — grounded web research pipeline

One research question → grounded, judged answer. The engine searches (multi-query),
crawls the best sources (tier-reordered: academic/standards/gov/docs/repo first),
fans out N analysis lenses over the shared corpus concurrently, then judges and
synthesizes a final answer. Stdout = the answer; the artifact keeps lens champions
plus the full corpus appendix (nothing silently dropped).

## Usage

```bash
bun run dag-research "<research question>" \
  [--council]            # conductor auto-authors the lenses from the corpus
  [--super]              # aggregate search mode (wider retrieval)
  [--k 8]                # search hits to consider (default 8)
  [--crawl 5]            # bodies to fetch (default 5; 0 = search snippets only)
  [--no-tier]            # disable source-tier crawl reordering
  [--lens-count N] [--conductor-model M] [--lens-model M] [--reason-model M]
  [--out path]           # artifact path (default /tmp/dag-research-<slug>-<ts>.md)
```

Requires a search/fetch backend (`TAVILY_API_KEY` or equivalent — see `.env.example`);
without web keys the script explains what's missing and exits.

## Discipline

- **One question per run.** A whole domain = several focused runs; long queries return
  nothing — split into short terms.
- **Read the artifact, not just stdout** when the answer will drive a design decision:
  lens champions often carry orthogonal caveats the synthesis compressed away.
