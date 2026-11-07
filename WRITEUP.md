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

- **The user keeps control.** You set the criteria (weights), they are hashed before anything is researched, and the agent never picks for you. The shortlist is three options with a brief, and the decision stays yours.
- **The agent's work is checkable.** Nothing asks for faith. The receipt is signed and hash-chained, and a check fails if the catalog, the model commitment or the counterfactual picks don't line up.

## How it works

```
criteria ──► research (every candidate) ──► rank: top 3 + brief ──► counterfactual re-rank ──► signed receipt
 (hashed)         ONE model: Qwen3.5-27B, open weights, temperature 0
                  a STARK proof of inference on every step (simulated in this demo)
```

There is no separate decision model. One LLM (Qwen3.5-27B) does everything, and every step carries a proof of inference, so you know the same audited model ran at every step.

### Steps

1. **Research.** The model researches every candidate in the committed catalog. Each step ends with a `Found:` line restating the spec numbers it used.
2. **Rank.** The same model gets the findings and the committed criteria, outputs `Top 3: id, id, id`, and writes a short brief. It does not pick for the user.
3. **Counterfactual.** The same model re-ranks the same findings with brand names rotated between options (option i carries option i+1's name, brand and OS; specs stay put). This run is proven too.

Determinism: temperature 0, seed 42, `think: false`.

### The three guarantees

1. **Same model.** Every step's proof verifies against the published weights commitment in `model.json` (the real sha256 of the Qwen3.5-27B weights layer from the Ollama registry).
2. **Candidates correct.** The candidate list is the committed catalog (`catalog_hash`), every candidate is researched, and every fact the model cites in a `Found:` line matches the catalog.
3. **Unbiased.** A fair model's picks follow the specs, so the counterfactual top 3 (as spec bundles) must equal the real top 3.

### Proofs: simulated in this demo

**The STARK proofs in this demo are simulated** by a hash stand-in, because we lacked the compute. `model.json` (`proof_note`) says so. For each step, `proof = sha256("mock-stark|" + weights_commitment + "|" + prompt_hash + "|" + output_hash)`, with `proof_system: "mock-stark-v0"`. This only shows that the receipt is consistent; it does not prove any inference ran. Real zkSTARK proving is the design (FlashProve-style, see below) and is not built.

### The receipt (v3, from `server.mjs`)

An Ed25519-signed JSON document:

- `catalog`, `catalog_hash`, `policy` (weights, k = 3), `policy_hash`
- `model`: `name`, `weights_commitment`, `proof_system`
- `steps`: `research` (per product), `rank` (with `top`), `counterfactual` (with `relabel` and `top`); each has `prompt`, `prompt_hash`, `output`, `output_hash`, `proof`, `prev`, `hash`
- `chain_head`, `public_key`, `receipt_hash` (SHA-256 of the canonical body) and `signature`

The first `prev` is `sha256(policy_hash + catalog_hash + weights_commitment)`; each step's `hash` is `sha256(canon(step without hash))`. The private key stays local (`.keys/`, gitignored); the public key is in `public-key.txt`.

### Verification

`verify.js` checks the receipt hash and signature, the policy and catalog hashes, the weights commitment against `model.json`, the hash chain, each step's proof, that every candidate was researched, that `Found:` lines match the catalog, and that the counterfactual top 3 equals the real top 3.

### What "verifiable" means today

Today the proof check is a hash stand-in, so it shows consistency of the receipt, not that the weights ran. The signature and hash chain are real. A real proof of inference would let anyone check, without the weights or a GPU, that the committed weights produced those exact tokens.

## Run it

```
ollama pull qwen3.5:4b             # qwen3.5:27b on a bigger machine
node server.mjs                    # http://localhost:8787
node verify.mjs receipts/latest.json
```

Env vars: `MODEL` (default `qwen3.5:4b`), `OLLAMA_URL` (default `http://127.0.0.1:11434`), `PORT` (default 8787).

**Compute note:** Qwen3.5-27B is the target model. It needs about 20 GB of memory, and our laptops have 16 GB, so the live run uses `qwen3.5:4b` through the identical code path. Set `MODEL=qwen3.5:27b` and point `OLLAMA_URL` at a bigger box to run the target. Without the server (e.g. on the static site), the page replays a recorded signed run and verifies it in the browser.

## The core technology: provable inference

In early November 2026, Anthropic published research on **provable inference** ("FlashProve"; https://www.anthropic.com/research/provable-inference, coverage: https://thenextweb.com/news/anthropic-flashprove-provable-inference-ai-model-identity). As reported:

- The provider commits to its model weights. Each reply includes a zero-knowledge proof that the committed weights produced exactly those output tokens. The weights stay hidden.
- The proof system is hash-based (an IOP compiled with hashes), which Anthropic says can give post-quantum security. That's the same family as STARKs. Coverage calls it a zkSNARK. We call it "proof of inference" and don't claim it is literally a STARK.
- Demo: Llama 4 Maverick (400B MoE). Proving runs at about 110 tok/s on one H100, at 70-95x normal GPU cost. Proofs are about 19 MB per 1,024 tokens. Verification takes about 17 s on a CPU and needs no weights. Key security properties are machine-checked in Lean. The code is Apache-2.0.
- **Limits:** it covers integer, greedy-decoding inference only, contexts up to 1,024 tokens and MoE models only. It hides the weights but not the architecture. It gives no confidentiality for prompts or outputs. It is a research prototype and isn't deployed for Claude.

Our steps use greedy decoding and short contexts, which is the regime this kind of proof targets.

**Related and complementary tech:**
- **GPU TEEs / confidential computing** (NVIDIA H100 CC mode; ~4-8% overhead, https://arxiv.org/abs/2409.03992). Hardware attestation of which model runs, and it also keeps the prompt private. It trusts the hardware vendor, whereas a ZK proof trusts only the math. In production, combine them: a TEE for privacy and the proof for public verifiability.
- **Survey** of ZK verifiable inference: https://arxiv.org/pdf/2511.19902

## Threat model

| Attack | Defense | Residual risk |
|---|---|---|
| A different model than the audited one | Per-step proofs against the published weights commitment | In this demo the proofs are simulated; real zkSTARK proving is next |
| Candidates dropped or facts altered | Catalog hash; every candidate researched; `Found:` lines checked against the catalog | Catalog data itself may be false |
| Brand preference in the model | Counterfactual re-rank with names rotated; top 3 as spec bundles must match | Bias via correlated attributes; one rotation is a sample, not a proof of fairness |
| Criteria changed after seeing the catalog | Policy hash committed first and signed | The user's own preferences are their call |
| Tampering with a receipt | Ed25519 signature over the receipt hash; hash chain | Trust in the published public key |
| Prompt injection in listings | Prompts use typed spec numbers, not free-text listing copy | Fake specs need merchant-side verification |
| Paid placement | Excluded from the prompts and disclosed separately | None in the prompts |

## Why it fits each track

- **Sandia (secure AI and agentic workflows):** a concrete agentic workflow with cryptographic commitments, a signed, hash-chained agent trace, a counterfactual test for hidden model behavior, and a clear path to proofs of inference. Security is measurable (Δ, hash checks, signatures) rather than a policy promise.
- **DoorDash Merchant Experience:** as agents start doing the ordering, merchants need a ranking they can trust and learn from. The receipt shows a merchant which specs cost them the pick and that their name didn't.
- **DoorDash Most Creative:** it pairs one open-weights model that researches and ranks, with a counterfactual check, and treats the verifiable-inference idea as the roadmap, so the user stays in charge while the agent does the legwork.

## What it doesn't cover yet

- **Real proofs.** The STARK proofs are simulated in this demo. Real zkSTARK proving (FlashProve-style) is next.
- **Correlated bias.** A model can still over-weight a trait one brand happens to have. Attribute-level counterfactuals are next.
- **False specs.** Fair ranking on false numbers is still wrong; catalog data needs its own verification.
- **Illustrative data.** Phone specs in the demo are illustrative, and the model has no web access.

## Next steps

1. Replace the hash stand-in with a real proof of inference (FlashProve-style) on every step.
2. Keep receipts in an append-only transparency log.
3. Attribute-level counterfactuals for correlated bias.
4. A merchant dashboard that aggregates receipts into "you lost 62% of picks on ETA."
