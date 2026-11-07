// Receipt verifier shared by the browser and the CLI (verify.mjs).
// env = { sha(str)->hex (async ok), verifySig(pubB64url, msg, sigB64)->bool, catalogText, decisionText }
import { decide, canon } from "./decision.js";

export async function verifyReceipt(r, env) {
  const checks = [];
  const add = (name, ok, detail = "") => checks.push({ name, ok, detail });
  const { receipt_hash, signature, ...body } = r;

  add("Receipt hash matches contents", (await env.sha(canon(body))) === receipt_hash);
  let sigOk = false; try { sigOk = await env.verifySig(r.public_key, receipt_hash, signature); } catch {}
  add("Ed25519 signature valid", sigOk, r.public_key.slice(0, 12) + "…");
  add("Criteria committed (policy hash)", (await env.sha(canon(r.policy))) === r.policy_hash);
  add("Catalog matches published catalog.json", (await env.sha(env.catalogText)) === r.catalog_hash);
  add("Scorer matches published decision.js", (await env.sha(env.decisionText)) === r.decision.scorer_hash);

  // Re-execute the decision model independently.
  const re = decide(JSON.parse(env.catalogText), r.policy);
  add("Re-executed ranking matches", canon(re.top) === canon(r.decision.top) && canon(re.scores) === canon(r.decision.scores),
    "top 3: " + re.top.join(", "));
  add("Identity-swap test: brand doesn't move scores", re.swap_max_delta === 0 && r.decision.swap_max_delta === 0,
    `max Δ ${re.swap_max_delta} over ${re.swaps} swaps`);

  // Research chain: every step links to the previous one and its output hash is honest.
  let prev = await env.sha(canon(r.policy) + r.catalog_hash), chainOk = true;
  for (const s of r.research.steps) {
    const { hash, ...rest } = s;
    if (s.prev !== prev || (await env.sha(canon(rest))) !== hash || (await env.sha(s.output)) !== s.output_hash || (await env.sha(s.prompt)) !== s.prompt_hash) chainOk = false;
    prev = hash;
  }
  add("Research loop hash chain intact", chainOk && prev === r.research.chain_head, `${r.research.steps.length} steps`);
  add("Model weights pinned", /^[0-9a-f]{64}$/.test(r.research.model_digest || ""), `${r.research.model} @ ${(r.research.model_digest || "").slice(0, 12)}…`);
  return { ok: checks.every(c => c.ok), checks };
}
