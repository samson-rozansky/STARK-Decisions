// STARK-Decisions decision model. Shared by the server and the browser verifier,
// so anyone can re-execute it and check the server's ranking. Its SHA-256 is
// recorded in every receipt as scorer_hash.

export const K = 3;
const IDENTITY = ["name", "brand", "os"];

// Deterministic JSON: sorted keys, so hashes match across machines.
export const canon = v =>
  Array.isArray(v) ? "[" + v.map(canon).join(",") + "]"
  : v && typeof v === "object" ? "{" + Object.keys(v).sort().map(k => JSON.stringify(k) + ":" + canon(v[k])).join(",") + "}"
  : JSON.stringify(v);

// Score one option from its specs only. `identity` is passed in so the swap test
// can prove it is ignored; `bias` exists only to simulate a compromised provider.
export function score(specs, identity, catalog, weights, bias) {
  let s = 0, tw = 0;
  for (const a of catalog.attributes) {
    const vals = catalog.items.map(x => x[a]), lo = Math.min(...vals), hi = Math.max(...vals);
    const n = hi === lo ? 1 : (specs[a] - lo) / (hi - lo);
    s += (weights[a] || 0) * (a === "price" ? 1 - n : n);
    tw += weights[a] || 0;
  }
  s = tw ? (100 * s) / tw : 0;
  if (bias && identity.brand === bias) s += 8;
  return Math.round(s * 1e4) / 1e4;
}

const perms = a => a.length < 2 ? [a] : a.flatMap((x, i) => perms([...a.slice(0, i), ...a.slice(i + 1)]).map(p => [x, ...p]));

// Rank options, keep the top K, and run the counterfactual identity-swap test:
// move name/brand/os between options while specs stay put, re-score, record max change.
export function decide(catalog, policy, bias = null) {
  const items = catalog.items;
  const ids = items.map(x => Object.fromEntries(IDENTITY.map(k => [k, x[k]])));
  const scores = Object.fromEntries(items.map(x => [x.id, score(x, x, catalog, policy.weights, bias)]));
  let swap_max_delta = 0;
  for (const p of perms(items.map((_, i) => i)))
    items.forEach((x, i) => {
      const d = Math.abs(score(x, ids[p[i]], catalog, policy.weights, bias) - scores[x.id]);
      if (d > swap_max_delta) swap_max_delta = Math.round(d * 1e4) / 1e4;
    });
  const top = [...items].sort((a, b) => scores[b.id] - scores[a.id] || a.id.localeCompare(b.id)).slice(0, policy.k || K).map(x => x.id);
  return { top, scores, swap_max_delta, swaps: perms(items.map((_, i) => i)).length };
}
