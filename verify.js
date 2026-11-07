// STARK-Decisions receipt verifier (v3), shared by the browser and the CLI (verify.mjs).
// env = { sha(str)->hex (async ok), verifySig(pubB64url, msg, sigB64)->bool, catalogText, model (parsed model.json) }

// Deterministic JSON: sorted keys, so hashes match across machines.
export const canon = v =>
  Array.isArray(v) ? "[" + v.map(canon).join(",") + "]"
  : v && typeof v === "object" ? "{" + Object.keys(v).sort().map(k => JSON.stringify(k) + ":" + canon(v[k])).join(",") + "}"
  : JSON.stringify(v);

// Demo stand-in for a zkSTARK proof of inference. A real verifier checks a STARK
// against the weights commitment; this one recomputes a hash binding the same inputs.
export const mockProof = (sha, commitment, s) => sha(`mock-stark|${commitment}|${s.prompt_hash}|${s.output_hash}`);

export const parseFound = out => {
  const m = out.match(/Found:\s*(.*)/);
  return m ? Object.fromEntries(m[1].split(",").map(p => p.trim().split(/\s+/)).map(([k, v]) => [k, +String(v).replace(/[$,]/g, "")])) : null;
};

export async function verifyReceipt(r, env) {
  const checks = [], add = (name, ok, detail = "") => checks.push({ name, ok, detail });
  const { receipt_hash, signature, ...body } = r;
  const cat = JSON.parse(env.catalogText), W = env.model.weights_commitment;

  add("Receipt hash matches contents", (await env.sha(canon(body))) === receipt_hash);
  let sigOk = false; try { sigOk = await env.verifySig(r.public_key, receipt_hash, signature); } catch {}
  add("Ed25519 signature valid", sigOk, r.public_key.slice(0, 12) + "…");
  add("Criteria committed before research", (await env.sha(canon(r.policy))) === r.policy_hash);

  // Same model at every step: each proof must verify against the PUBLISHED commitment.
  let proofsOk = r.model.weights_commitment === W, nOk = 0;
  for (const s of r.steps) { const ok = (await mockProof(env.sha, W, s)) === s.proof; if (ok) nOk++; else proofsOk = false; }
  add("Every step proven by the published model", proofsOk, `${nOk}/${r.steps.length} proofs vs ${W.slice(0, 10)}…`);

  // Candidates correct: the committed catalog, every candidate researched, every cited fact matches.
  add("Candidates match the committed catalog", (await env.sha(env.catalogText)) === r.catalog_hash, `${cat.items.length} candidates`);
  const found = {};
  for (const s of r.steps) if (s.kind === "research") found[s.product] = parseFound(s.output);
  const factsOk = cat.items.every(x => found[x.id] && cat.attributes.every(a => found[x.id][a] === x[a]));
  add("Every candidate researched, facts match", factsOk, `${Object.keys(found).length}/${cat.items.length} researched`);

  // Research path integrity: each step links to the one before it.
  let prev = await env.sha(r.policy_hash + r.catalog_hash + r.model.weights_commitment), chainOk = true;
  for (const s of r.steps) {
    const { hash, ...rest } = s;
    if (s.prev !== prev || (await env.sha(canon(rest))) !== hash || (await env.sha(s.output)) !== s.output_hash || (await env.sha(s.prompt)) !== s.prompt_hash) chainOk = false;
    prev = hash;
  }
  add("Research path hash chain intact", chainOk && prev === r.chain_head, `${r.steps.length} steps`);

  // Unbiased: with brand names rotated, the model must pick the same spec bundles.
  const rank = r.steps.find(s => s.kind === "rank"), cf = r.steps.find(s => s.kind === "counterfactual");
  const same = rank && cf && canon([...rank.top].sort()) === canon([...cf.top].sort());
  add("Brand names rotated: picks unchanged", !!same, cf ? `${rank.top.join(",")} vs ${cf.top.join(",")}` : "missing");
  return { ok: checks.every(c => c.ok), checks };
}
