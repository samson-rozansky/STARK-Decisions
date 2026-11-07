// STARK-Decisions server: one LLM researches every candidate, ranks top 3, counterfactual re-rank; every step carries a (simulated) proof; signed receipt.
// Run:  node server.mjs        (needs Ollama running with $MODEL pulled)
// Env:  MODEL=qwen3.5:27b  OLLAMA_URL=http://host:11434  PORT=8787
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { canon } from "./verify.js";
const K = 3;

const DIR = path.dirname(new URL(import.meta.url).pathname);
const MODEL = process.env.MODEL || "qwen3.5:4b";
const OLLAMA = process.env.OLLAMA_URL || "http://127.0.0.1:11434";
const PORT = +(process.env.PORT || 8787);
const OPTIONS = { temperature: 0, seed: 42, num_predict: 400 }; // greedy: reproducible, and what provable inference assumes

const sha = s => crypto.createHash("sha256").update(s).digest("hex");
const read = f => fs.readFileSync(path.join(DIR, f), "utf8");

// Signing key: private stays local (.keys is gitignored), public key is published in the repo.
const KEYFILE = path.join(DIR, ".keys/ed25519.pem");
if (!fs.existsSync(KEYFILE)) {
  fs.mkdirSync(path.dirname(KEYFILE), { recursive: true });
  fs.writeFileSync(KEYFILE, crypto.generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
}
const priv = crypto.createPrivateKey(read(".keys/ed25519.pem"));
const PUB = crypto.createPublicKey(priv).export({ format: "jwk" }).x; // raw key, base64url
fs.writeFileSync(path.join(DIR, "public-key.txt"), PUB + "\n");

async function weightsCommitment() {
  const mj = JSON.parse(read("model.json"));
  if (MODEL === mj.ollama_tag) return mj.weights_commitment; // published sha256 of the Qwen3.5-27B weights layer
  const r = await fetch(OLLAMA + "/api/tags").then(r => r.json()); // local run: Ollama digest of the running model
  const m = r.models.find(m => m.name === MODEL || m.model === MODEL);
  if (!m) throw new Error(`model ${MODEL} not found in Ollama; run: ollama pull ${MODEL}`);
  return m.digest;
}
async function ask(prompt) {
  const r = await fetch(OLLAMA + "/api/chat", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, stream: false, think: false, options: OPTIONS, messages: [{ role: "user", content: prompt }] }) });
  if (!r.ok) throw new Error("ollama: " + (await r.text()));
  return (await r.json()).message.content.trim();
}

const facts = (x, cat) => cat.attributes.map(a => `${a} ${a === "price" ? "$" + x[a] : x[a]}`).join(", ");
const foundLine = out => (out.match(/^Found:\s*(.*)$/m) || [, ""])[1].trim();
// ponytail: simulated proof; real zkSTARK proving (FlashProve-style) replaces this one function
const proof = (wc, ph, oh) => sha("mock-stark|" + wc + "|" + ph + "|" + oh);
function parseTop(out, ids) {
  const line = (out.match(/Top\s*3\s*:\s*(.*)/i) || [, ""])[1];
  const top = []; for (const t of line.match(/\bp?\w+\b/g) || []) if (ids.includes(t) && !top.includes(t)) top.push(t);
  return top.slice(0, K);
}

async function pipeline(weights, emit) {
  const catalogText = read("catalog.json"), catalog = JSON.parse(catalogText), items = catalog.items, ids = items.map(i => i.id);
  const policy = { weights, k: K }, policy_hash = sha(canon(policy)), catalog_hash = sha(catalogText);
  const wc = await weightsCommitment();
  const steps = []; let prev = sha(policy_hash + catalog_hash + wc);
  const record = async (s, prompt) => {
    const out = await ask(prompt);
    Object.assign(s, { prompt, prompt_hash: sha(prompt), output: out, output_hash: sha(out) });
    if (s.kind !== "research") s.top = parseTop(out, ids);
    s.proof = proof(wc, s.prompt_hash, s.output_hash);
    s.prev = prev; s.hash = prev = sha(canon(s)); steps.push(s); emit({ type: "step", step: s });
    return s;
  };

  // 1) research EVERY candidate
  const found = {};
  for (const x of items) {
    const s = await record({ kind: "research", product: x.id }, `You are a neutral product researcher. Product: ${x.name}. Spec sheet: ${facts(x, catalog)}.
Buyer priorities (weights): ${canon(weights)}.
Ask the single most useful question a careful buyer should check about this product, then answer it in one or two sentences using the spec sheet. Do not praise or criticize the brand itself.
Reply exactly as:
Q: <question>
A: <answer>
Found: <attr> <value>, <attr> <value>, ...
End with the Found line, restating the spec-sheet numbers you used.`);
    found[x.id] = foundLine(s.output);
  }

  // 2) rank: same model picks the top 3
  const list = (name) => items.map(x => `- ${x.id}: ${name(x)}. Findings: ${found[x.id]}`).join("\n");
  const rankPrompt = (name) => `You are a neutral shopping assistant. Buyer priorities (weights): ${canon(weights)}.
Researched options:
${list(name)}
Pick the best 3 for these priorities using the findings. First line exactly: Top 3: id, id, id
Then a short brief: for each pick, who it suits and one trade-off.`;
  await record({ kind: "rank" }, rankPrompt(x => `${x.name} (${x.brand}, ${x.os})`));

  // 3) counterfactual: option i carries option i+1's name/brand/os, specs unchanged
  const relabel = {}; items.forEach((x, i) => relabel[x.id] = items[(i + 1) % items.length].id);
  const byId = Object.fromEntries(items.map(x => [x.id, x]));
  await record({ kind: "counterfactual", relabel }, rankPrompt(x => { const y = byId[relabel[x.id]]; return `${y.name} (${y.brand}, ${y.os})`; }));

  const body = {
    project: "STARK-Decisions", version: 3, created: new Date().toISOString(),
    catalog: "catalog.json", catalog_hash, policy, policy_hash,
    model: { name: MODEL, weights_commitment: wc, proof_system: "mock-stark-v0" },
    steps, chain_head: prev, public_key: PUB,
  };
  const receipt_hash = sha(canon(body));
  const signature = crypto.sign(null, Buffer.from(receipt_hash), priv).toString("base64");
  return { ...body, receipt_hash, signature };
}

const STATIC = { "/": "index.html", "/index.html": "index.html", "/catalog.json": "catalog.json", "/catalog-food.json": "catalog-food.json", "/model.json": "model.json", "/verify.js": "verify.js",
  "/receipts/sample.json": "receipts/sample.json", "/receipts/sample-food.json": "receipts/sample-food.json", "/receipts/qwen3.5-4b-run.json": "receipts/qwen3.5-4b-run.json", "/WRITEUP.md": "WRITEUP.md", "/slides.html": "slides.html", "/public-key.txt": "public-key.txt" };
const TYPES = { html: "text/html", js: "text/javascript", json: "application/json", md: "text/markdown", txt: "text/plain" };

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  if (req.method === "GET" && url.pathname === "/api/health") return res.end(JSON.stringify({ ok: true, model: MODEL }));
  if (req.method === "POST" && url.pathname === "/api/run") {
    let raw = ""; for await (const c of req) { raw += c; if (raw.length > 1e4) return res.writeHead(413).end(); }
    let input; try { input = JSON.parse(raw); } catch { return res.writeHead(400).end("bad json"); }
    const attrs = JSON.parse(read("catalog.json")).attributes;
    const weights = Object.fromEntries(attrs.map(a => [a, Math.max(0, Math.min(1, +input.weights?.[a] || 0))]));
    res.writeHead(200, { "content-type": "application/x-ndjson" });
    const emit = o => res.write(JSON.stringify(o) + "\n");
    try {
      const receipt = await pipeline(weights, emit);
      emit({ type: "receipt", receipt });
      fs.mkdirSync(path.join(DIR, "receipts"), { recursive: true }), fs.writeFileSync(path.join(DIR, "receipts/latest.json"), JSON.stringify(receipt, null, 2));
    } catch (e) { emit({ type: "error", message: String(e.message || e) }); }
    return res.end();
  }
  const f = STATIC[url.pathname];
  if (req.method === "GET" && f && fs.existsSync(path.join(DIR, f)))
    return res.writeHead(200, { "content-type": TYPES[f.split(".").pop()] + "; charset=utf-8" }).end(read(f));
  res.writeHead(404).end("not found");
}).listen(PORT, "127.0.0.1", () => console.log(`STARK-Decisions on http://localhost:${PORT}  model=${MODEL}`));
