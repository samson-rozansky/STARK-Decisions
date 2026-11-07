# STARK-Decisions: a shopping agent that researches for you and can prove it played fair

**Repo:** https://github.com/samson-rozansky/STARK-Decisions · **Site:** http://samson.rozansky.org/STARK-Decisions/ · **Slides:** `slides.html`

**Tracks:** Sandia (securely implementing AI and agentic workflows) · DoorDash (Best Merchant Experience / Most Creative Solution)

## The problem

Agentic commerce asks you to hand over a purchase: "buy me a good phone under $1,100", "order dinner for four." The agent's ranking now decides which merchant gets the sale. That creates a new and invisible conflict of interest:

- A **model provider** could train a brand preference into its weights (iPhone over Android, a partner chain over a local restaurant). You would never see it in a prompt.
- A **platform** could run a fair model when auditors are watching and a tuned one in production.
- An **agent** could quietly change your criteria after it sees which brands are in the race.
- **Merchants** who lose get no explanation and can't tell whether they lost on merit.

**Our goal:** every recommendation comes with a receipt that anyone can check.

## Why people will trust it

People already distrust AI that thinks for them, or that might be steered by whoever runs it. STARK-Decisions responds in two ways:

- **The user keeps control.** You set the criteria (weights), they are hashed before any product is scored, and the agent never picks for you. The final brief explicitly does not choose; it ends by naming the one factor that should decide it. The decision stays yours.
- **The agent's work is checkable.** Nothing asks for faith. Your browser re-runs the scorer, and a CLI can re-run the research loop. If the server cheated, a check fails.

## How it works

```
criteria ──► [1] DECISION MODEL ──► top 3 ──► [2] RESEARCH LOOP ──► brief ──► signed receipt
 (hashed)     open scorer,                    Qwen3.5, 2 rounds       (no pick)   Ed25519
              swap test                       per product, chained
```

### Step 1: decision model (`decision.js`)

- An open, deterministic scorer. It scores **specs only** (normalized per attribute across the catalog, weighted by the user's criteria; price is inverted). Name, brand and OS are never inputs.
- The user's criteria are committed via SHA-256 (`policy_hash`) before scoring.
- **Identity-swap counterfactual test.** Keep each option's specs fixed, permute the identity fields (name, brand, os) across options, re-score, and record the maximum score change. For a neutral scorer this is exactly 0. The receipt records `swap_max_delta` and the number of swaps.
- Output: the top 3 options.
- The same file runs on the server and in the browser, so anyone can re-execute it. Its hash is recorded in the receipt as `scorer_hash`.

### Step 2: auto-research loop (Qwen3.5)

- For each of the top 3 products, the model runs 2 rounds of question then answer: it asks the most useful next question a careful buyer should check, and answers from the spec sheet and widely known facts. It is told not to praise or criticize the brand. No web access in this build.
- A final brief says, for each option, who it suits and one trade-off. It does **not** choose for the user.
- Determinism: temperature 0, seed 42, `num_predict` 220, and the Ollama weights digest pinned.
- Every step (prompt, output, hashes of both) is hash-chained. The chain starts from `sha256(policy + catalog hash)`, and each step stores the previous step's hash.

### The receipt (from `server.mjs`)

An Ed25519-signed JSON document containing:

- `policy` and `policy_hash` (the committed criteria)
- `catalog_hash` (hash of `catalog.json`)
- `decision`: `scorer: "decision.js"`, `scorer_hash`, `top`, per-option `scores`, `swap_max_delta`, `swaps`
- `research`: `model`, `model_digest` (Ollama weights digest), `options` (temperature, seed, num_predict), `rounds`, `steps` (each with `kind`, `product`, `round`, `prompt`, `prompt_hash`, `output`, `output_hash`, `prev`, `hash`), and `chain_head`
- `public_key`, `receipt_hash` (SHA-256 of the canonical body) and `signature`

The private key stays local (`.keys/`, gitignored); the public key is published in `public-key.txt`.

### Verification

`verify.js` is shared by the browser and the CLI. It checks:

1. the receipt hash and Ed25519 signature
2. the policy hash
3. the catalog hash against the published `catalog.json`
4. the scorer hash against the published `decision.js`
5. the ranking, by **re-executing** `decision.js` and comparing top 3 and scores
6. the swap test, which must show max Δ of 0
7. the research hash chain, step by step
8. that the model weights digest is pinned

`node verify.mjs receipt.json --rerun` goes further: it checks the local Ollama digest matches the receipt, re-runs every research prompt at temperature 0, and checks each output hashes to the recorded value.

### What "verifiable" means today, and what it will mean

**Today** it means reproducible re-execution plus signatures plus a hash chain. That is real, but verifying the research step requires the verifier to have the same weights and a GPU (or patience) to re-run it. It also relies on greedy decoding being bit-reproducible on the verifier's setup, so a different runtime can in principle fail a legitimate run.

**Future:** a zero-knowledge proof of inference, as in Anthropic's FlashProve research (below). A proof would let anyone verify that the committed weights produced those exact tokens without holding the weights or a GPU. The proof family is hash-based (STARK-style), which is the "STARK" in the name. We do not implement a proof here and don't claim to.

## Run it

```
ollama pull qwen3.5:4b             # qwen3.5:27b on a bigger machine
node server.mjs                    # http://localhost:8787
node verify.mjs receipts/latest.json --rerun
```

Env vars: `MODEL` (default `qwen3.5:4b`), `OLLAMA_URL` (default `http://127.0.0.1:11434`), `ROUNDS` (default 2), `PORT` (default 8787).

**Compute note:** Qwen3.5-27B is the target model. It needs about 20 GB of memory, and our laptops have 16 GB, so the live run uses `qwen3.5:4b` through the identical code path. Set `MODEL=qwen3.5:27b` and point `OLLAMA_URL` at a bigger box to run the target. Without the server (e.g. on the static site), the page replays a recorded signed run and verifies it in the browser.

## The core technology: provable inference

In early November 2026, Anthropic published research on **provable inference** ("FlashProve"; https://www.anthropic.com/research/provable-inference, coverage: https://thenextweb.com/news/anthropic-flashprove-provable-inference-ai-model-identity). As reported:

- The provider commits to its model weights. Each reply includes a zero-knowledge proof that the committed weights produced exactly those output tokens. The weights stay hidden.
- The proof system is hash-based (an IOP compiled with hashes), which Anthropic says can give post-quantum security. That's the same family as STARKs. Coverage calls it a zkSNARK. We call it "proof of inference" and don't claim it is literally a STARK.
- Demo: Llama 4 Maverick (400B MoE). Proving runs at about 110 tok/s on one H100, at 70-95x normal GPU cost. Proofs are about 19 MB per 1,024 tokens. Verification takes about 17 s on a CPU and needs no weights. Key security properties are machine-checked in Lean. The code is Apache-2.0.
- **Limits:** it covers integer, greedy-decoding inference only, contexts up to 1,024 tokens and MoE models only. It hides the weights but not the architecture. It gives no confidentiality for prompts or outputs. It is a research prototype and isn't deployed for Claude.

Our research loop already uses greedy decoding and short contexts, which is the regime this kind of proof targets.

**Related and complementary tech:**
- **GPU TEEs / confidential computing** (NVIDIA H100 CC mode; ~4-8% overhead, https://arxiv.org/abs/2409.03992). Hardware attestation of which model runs, and it also keeps the prompt private. It trusts the hardware vendor, whereas a ZK proof trusts only the math. In production, combine them: a TEE for privacy and the proof for public verifiability.
- **zkML** (EZKL proves ONNX inference with Halo2 SNARKs, https://ezkl.xyz). Practical for small scoring models today, so a small open scorer could be proven this way.
- **Survey** of ZK verifiable inference: https://arxiv.org/pdf/2511.19902

## Threat model

| Attack | Defense | Residual risk |
|---|---|---|
| Brand preference trained into the ranking model | Scorer is open, deterministic and specs-only; the browser re-executes it; identity-swap test per decision | Bias carried through correlated attributes (over-weighting "ecosystem") |
| Server shows a ranking it didn't compute (e.g. secretly favors a brand; the demo has a "cheating server" toggle) | Re-executed ranking and `scorer_hash` checks fail; swap test fails | None for the ranking, since it is fully re-executable |
| Fair research model for audits, different one in production | Pinned weights digest, temperature 0 and seed; `--rerun` reproduces outputs | Today the verifier needs the weights and must trust that the digest names what ran; closed by ZK proof of inference later |
| Research text slanted toward a product | Hash-chained prompts and outputs are inspectable and re-runnable; brief doesn't pick | The model's own knowledge can still be wrong or skewed; a human reads the steps |
| Criteria changed after seeing the catalog | Policy hash committed first and included in the signed receipt | The user's own preferences are their call |
| Tampering with a receipt | Ed25519 signature over the receipt hash; hash chain | Trust in the published public key |
| Prompt injection in listings | Scorer consumes only typed numeric attributes; the research prompt uses the spec sheet, not free-text listing copy | Fake specs need merchant-side verification |
| Paid placement | Sponsorship excluded from scoring and disclosed separately | None in scoring |

## Why it fits each track

- **Sandia (secure AI and agentic workflows):** a concrete agentic workflow with cryptographic commitments, a reproducible and signed agent trace, an adversarial test for hidden model behavior, and a clear path to proofs of inference. Security is measurable (Δ, hash checks, signatures) rather than a policy promise.
- **DoorDash Merchant Experience:** as agents start doing the ordering, merchants need a ranking they can trust and learn from. The receipt shows a merchant which specs cost them the pick and that their name didn't.
- **DoorDash Most Creative:** it pairs a neutral, auditable shortlist with an open-weights research agent and treats the verifiable-inference idea as the roadmap, so the user stays in charge while the agent does the legwork.

## What it doesn't cover yet

- **Proof without re-running.** Verifying the research step means re-running it on the same weights. ZK proof of inference would remove that.
- **Correlated bias.** A scorer can still over-weight a trait one brand happens to have. Attribute-level counterfactuals are next.
- **False specs.** Fair scoring on false numbers is still wrong; catalog data needs its own verification.
- **Illustrative data.** Phone specs in the demo are illustrative, and the research model has no web access.

## Next steps

1. Swap re-execution for a real proof of inference (FlashProve-style) on the research step.
2. Prove the scorer with EZKL, and keep receipts in an append-only transparency log.
3. Attribute-level counterfactuals for correlated bias.
4. A merchant dashboard that aggregates receipts into "you lost 62% of picks on ETA."
