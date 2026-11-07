// CLI verifier:  node verify.mjs receipts/sample.json [--rerun]
// --rerun re-executes every research step against Ollama (same model digest, temperature 0)
// and checks the outputs hash to the same values.
import fs from "node:fs";
import crypto from "node:crypto";
import { verifyReceipt } from "./verify.js";

const file = process.argv[2] || "receipts/sample.json";
const r = JSON.parse(fs.readFileSync(file, "utf8"));
const sha = s => crypto.createHash("sha256").update(s).digest("hex");
const verifySig = (x, msg, sig) => crypto.verify(null, Buffer.from(msg),
  crypto.createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x }, format: "jwk" }), Buffer.from(sig, "base64"));

const { ok, checks } = await verifyReceipt(r, { sha, verifySig, catalogText: fs.readFileSync(r.catalog || "catalog.json", "utf8"), decisionText: fs.readFileSync("decision.js", "utf8") });
for (const c of checks) console.log(`${c.ok ? "✓" : "✗"} ${c.name}${c.detail ? "  (" + c.detail + ")" : ""}`);

if (process.argv.includes("--rerun")) {
  const OLLAMA = process.env.OLLAMA_URL || "http://127.0.0.1:11434";
  const tags = await fetch(OLLAMA + "/api/tags").then(x => x.json());
  const m = tags.models.find(m => m.name === r.research.model);
  console.log(`${m?.digest === r.research.model_digest ? "✓" : "✗"} Local weights digest matches receipt`);
  let same = 0;
  for (const s of r.research.steps) {
    const out = await fetch(OLLAMA + "/api/chat", { method: "POST", body: JSON.stringify({ model: r.research.model, stream: false, think: false, options: r.research.options, messages: [{ role: "user", content: s.prompt }] }) })
      .then(x => x.json()).then(j => j.message.content.trim());
    if (sha(out) === s.output_hash) same++;
  }
  console.log(`${same === r.research.steps.length ? "✓" : "✗"} Re-ran research loop: ${same}/${r.research.steps.length} steps reproduced bit-for-bit`);
}
process.exit(ok ? 0 : 1);
