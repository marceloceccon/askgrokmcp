# Consensus Validation Protocol (CVP) v1.4

A structured, multi-round analysis protocol powered by the `grok_consensus` MCP tool. CVP enables Claude to leverage Grok as an independent analytical counterpart for deep, iterative reasoning on any topic.

## Overview

The Consensus Validation Protocol runs multiple rounds of progressively deeper analysis through Grok's language model. Each round builds on the full conversation history, ensuring coherent, non-repetitive refinement. The heavy lifting is performed server-side by the `grok_consensus` tool for efficiency — Claude only needs to make a single tool call.

## Activation Triggers

This protocol activates when the user says any of the following (or close variants):

- **"Ask Grok"** — followed by a topic or claim
- **"Ask Grok to validate..."**
- **"Run CVP on..."**
- **"Consensus check with Grok"**
- **"Validate this with Grok"**

### Examples

```
Ask Grok to validate whether intermittent fasting improves longevity
Run CVP on the claim that remote work reduces productivity
Consensus check with Grok on quantum computing timelines
Run CVP on climate change mitigation strategies for 5 rounds
```

## How It Works

### 1. Claude calls `grok_consensus` once

When a CVP trigger is detected, Claude invokes the `grok_consensus` tool with:

| Argument | Type | Required | Description |
|----------|------|----------|-------------|
| `topic` | string | Yes | The topic, claim, or question to analyze |
| `rounds` | number | No | Number of rounds (default: 3, max: 10) |

### 2. The tool runs the protocol server-side

The `grok_consensus` tool internally executes the full multi-round protocol:

- **Round 1 — Initial Analysis:** Grok provides a comprehensive, objective analysis of the topic covering key claims, evidence, uncertainties, and misconceptions.
- **Round 2 — Counterarguments:** Grok challenges its own analysis, identifying the strongest counterarguments and alternative viewpoints.
- **Round 3 — Evidence Assessment:** Grok evaluates the strength of evidence on all sides, distinguishing well-established facts from contested claims.
- **Round 4 — Synthesis:** Grok integrates all rounds into a balanced conclusion with confidence levels.
- **Round 5+ — Refinement:** Additional rounds deepen the analysis with new perspectives and edge cases.

Conversation history is maintained properly across rounds — each round sees the full prior context, enabling genuine iterative refinement rather than redundant restating.

### 3. Claude receives structured results

The tool returns a structured Markdown report with all round-by-round analysis, which Claude can then summarize, quote, or present directly to the user.

## Custom Round Count

Users can request a specific number of rounds:

```
Run CVP on AI safety concerns for 7 rounds
Ask Grok to validate this claim — use 5 rounds
```

- **Default:** 3 rounds (good balance of depth and speed)
- **Minimum:** 1 round (quick single-pass analysis)
- **Maximum:** 10 rounds (exhaustive deep-dive)

Higher round counts yield more thorough analysis at the cost of additional latency, since each round is a separate API call to Grok.

## Output Format

The tool returns results in this structure:

```markdown
## Consensus Validation Protocol — Results

| Field | Value |
|-------|-------|
| **Topic** | {topic} |
| **Rounds completed** | {n} |
| **Model** | {model} |

### Round 1
{Initial analysis content}

### Round 2
{Counterarguments and critique}

### Round 3
{Evidence assessment and final synthesis}
```

## Design Principles

- **Concise and factual.** Each round advances the analysis — no filler or repetition.
- **Collaborative tone.** Grok acts as an analytical partner, not an adversary.
- **Evidence-based.** Claims are grounded in reasoning and evidence, with uncertainty explicitly acknowledged.
- **Server-side efficiency.** The entire loop runs within a single MCP tool call, minimizing round-trips between Claude and the server.

## Version History

| Version | Changes |
|---------|---------|
| 1.4 | Protocol moved server-side into `grok_consensus` tool. Single tool call replaces client-side loop. |
| 1.3 | Initial CVP as a Claude Code skill with client-side loop management. |
