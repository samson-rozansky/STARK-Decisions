// STARK-Decisions server: decision model -> top 3 -> Qwen auto-research loop -> signed receipt.
// Run:  node server.mjs        (needs Ollama running with $MODEL pulled)
// Env:  MODEL=qwen3.5:27b  OLLAMA_URL=http://host:11434  ROUNDS=2  PORT=8787
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { decide, canon, K } from "./decision.js";

const DIR = path.dirname(new URL(import.meta.url).pathname);
const MODEL = process.env.MODEL || "qwen3.5:4b";
const OLLAMA = process.env.OLLAMA_URL || "http://127.0.0.1:11434";
const ROUNDS = +(process.env.ROUNDS || 2);
const PORT = +(process.env.PORT || 8787);
const OPTIONS = { temperature: 0, seed: 42, num_predict: 220 }; // greedy: reproducible, and what provable inference assumes

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

async function modelDigest() {
  const r = await fetch(OLLAMA + "/api/tags").then(r => r.json());
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

const facts = (x, cat) => cat.attributes.map(a => `${a}: ${a === "price" ? "$" + x[a] : x[a] + "/100"}`).join(", ");

async function pipeline(weights, tamper, emit) {
  const catalogText = read("catalog.json"), catalog = JSON.parse(catalogText);
  const policy = { weights, k: K };

  // Step 1: decision model. In tamper mode the server secretly favors a brand but still claims the honest scorer.
  const decision = decide(catalog, policy, tamper ? "Apple" : null);
  if (tamper) decision.swap_max_delta = 0; // a cheating server would also lie about its swap test
  emit({ type: "decision", decision, items: catalog.items });

  // Step 2: auto-research loop over the top 3. Every step is hash-chained.
  const digest = await modelDigest();
  const steps = []; let prev = sha(canon(policy) + sha(catalogText));
  const record = (s) => { s.prev = prev; s.hash = prev = sha(canon(s)); steps.push(s); emit({ type: "step", step: s }); };
  const notes = {};
  for (const id of decision.top) {
    const x = catalog.items.find(i => i.id === id); notes[id] = [];
    for (let r = 1; r <= ROUNDS; r++) {
      const prompt = `You are a neutral product researcher. Product: ${x.name}. Spec sheet: ${facts(x, catalog)}.
Buyer priorities (weights): ${canon(weights)}.
Notes so far: ${notes[id].join(" | ") || "none"}.
Ask the single most useful next question a careful buyer should check about this product, then answer it in one or two sentences using the spec sheet and widely known facts. Do not praise or criticize the brand itself.
Reply exactly as:
Q: <question>
A: <answer>`;
      const out = await ask(prompt);
      notes[id].push(out.replace(/\s+/g, " "));
      record({ kind: "research", product: id, round: r, prompt, prompt_hash: sha(prompt), output: out, output_hash: sha(out) });
    }
  }
  const finalPrompt = `You are a neutral shopping assistant. The buyer's priorities: ${canon(weights)}.
Shortlist (from an audited decision model) with research notes:
${decision.top.map(id => { const x = catalog.items.find(i => i.id === id); return `- ${x.name} (${facts(x, catalog)}): ${notes[id].join(" ")}`; }).join("\n")}
Write a short brief: for each option, one line on who it suits best and one trade-off. Do not pick for the buyer; end with one sentence on what single factor should decide it.`;
  const brief = await ask(finalPrompt);
  record({ kind: "brief", prompt: finalPrompt, prompt_hash: sha(finalPrompt), output: brief, output_hash: sha(brief) });

  // Signed receipt
  const body = {
    project: "STARK-Decisions", version: 1, created: new Date().toISOString(),
    policy, policy_hash: sha(canon(policy)),
    catalog_hash: sha(catalogText),
    decision: { scorer: "decision.js", scorer_hash: sha(read("decision.js")), ...decision },
    research: { model: MODEL, model_digest: digest, options: OPTIONS, rounds: ROUNDS, steps, chain_head: prev },
    public_key: PUB,
  };
  const receipt_hash = sha(canon(body));
  const signature = crypto.sign(null, Buffer.from(receipt_hash), priv).toString("base64");
  return { ...body, receipt_hash, signature };
}

const STATIC = { "/": "index.html", "/index.html": "index.html", "/decision.js": "decision.js", "/catalog.json": "catalog.json",
  "/receipts/sample.json": "receipts/sample.json", "/WRITEUP.md": "WRITEUP.md", "/slides.html": "slides.html", "/public-key.txt": "public-key.txt" };
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
      const receipt = await pipeline(weights, !!input.tamper, emit);
      emit({ type: "receipt", receipt });
      if (!input.tamper) fs.mkdirSync(path.join(DIR, "receipts"), { recursive: true }), fs.writeFileSync(path.join(DIR, "receipts/latest.json"), JSON.stringify(receipt, null, 2));
    } catch (e) { emit({ type: "error", message: String(e.message || e) }); }
    return res.end();
  }
  const f = STATIC[url.pathname];
  if (req.method === "GET" && f && fs.existsSync(path.join(DIR, f)))
    return res.writeHead(200, { "content-type": TYPES[f.split(".").pop()] + "; charset=utf-8" }).end(read(f));
  res.writeHead(404).end("not found");
}).listen(PORT, "127.0.0.1", () => console.log(`STARK-Decisions on http://localhost:${PORT}  model=${MODEL}`));
