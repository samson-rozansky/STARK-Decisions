// CLI verifier:  node verify.mjs receipts/sample.json
import fs from "node:fs";
import crypto from "node:crypto";
import { verifyReceipt } from "./verify.js";

const r = JSON.parse(fs.readFileSync(process.argv[2] || "receipts/sample.json", "utf8"));
const sha = s => crypto.createHash("sha256").update(s).digest("hex");
const verifySig = (x, msg, sig) => crypto.verify(null, Buffer.from(msg),
  crypto.createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x }, format: "jwk" }), Buffer.from(sig, "base64"));
const model = JSON.parse(fs.readFileSync("model.json", "utf8"));

const { ok, checks } = await verifyReceipt(r, { sha, verifySig, model, catalogText: fs.readFileSync(r.catalog || "catalog.json", "utf8") });
for (const c of checks) console.log(`${c.ok ? "✓" : "✗"} ${c.name}${c.detail ? "  (" + c.detail + ")" : ""}`);
process.exit(ok ? 0 : 1);
