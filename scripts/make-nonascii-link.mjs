/**
 * Build a signing link whose summary contains the branch glyph (U+2514
 * U+2500) - the character that lives in every child agent's display name and
 * that `btoa` refuses outright.
 *
 * Encodes exactly the way apps/dashboard/lib/sign-link.ts does, so loading
 * the result in web/index.html is a real test of the two sides agreeing
 * rather than of this script agreeing with itself.
 */
const GLYPH = String.fromCharCode(0x2514, 0x2500);

const payload = {
  receiverId: "work12-testnet-fleet.fac.floatv4.testnet",
  methodName: "freeze_node",
  args: { node_id: 1, frozen: true },
  gasTgas: 100,
  depositYocto: "1",
  summary: `Freeze ${GLYPH} marketing`,
};

const json = JSON.stringify(payload);
const bytes = new TextEncoder().encode(json);
let binary = "";
for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
const b64url = Buffer.from(binary, "binary")
  .toString("base64")
  .replace(/\+/g, "-")
  .replace(/\//g, "_")
  .replace(/=+$/, "");

console.log(`  summary being sent: ${payload.summary}`);
console.log(`  bytes: ${bytes.length}   base64url length: ${b64url.length}`);
console.log(`http://127.0.0.1:8080/?network=testnet&action=${b64url}`);
