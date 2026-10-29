/**
 * Links for the things a human still has to do, and for checking the rest.
 *
 * WHAT THIS DELIBERATELY IS NOT. Outlayer hands the human a URL into its own
 * hosted app with the context pre-baked — `app.outlayer.ai/wallet/fund?to=…
 * &amount=…&token=…`. Float has no hosted app for a NEAR vault. The
 * `usefloat.xyz` domains vendored into apps/dashboard were checked on
 * 2026-10-29 and all three are unreachable; that dashboard's own skill.md is
 * the SOLANA product's, talking about Phantom, Solscan and paying Solana
 * addresses. A link there would send someone somewhere that cannot help them,
 * which is strictly worse than printing a command they can read.
 *
 * The funding handoff is also mostly moot now — the wizard registers and funds
 * the vault itself. What a human is still needed for is ACQUIRING the token,
 * and what the wizard never gave them is any way to SEE what it did. Nine
 * steps of output scroll past and the only evidence is the wizard's own word
 * for it.
 *
 * So: every destination here was verified live, and every link carries a
 * sentence saying what it is for. The second rule is Outlayer's and it is the
 * part worth copying — "a bare URL from an agent asking for account access is
 * what a phishing attempt looks like."
 *
 * AND NO LINK EVER CARRIES A SECRET. A key or phrase in a query string lands
 * in browser history, server logs and referrer headers. The signature of this
 * module takes no secret at all, so a caller cannot put one in a URL even by
 * accident.
 */

/** Verified live 2026-10-29; `/accounts/<id>` returns 200 on both. */
const EXPLORER = {
  mainnet: "https://explorer.near.org",
  testnet: "https://explorer.testnet.near.org",
};

/**
 * @param canFundFromOwner  false when the owner holds none of the token, which
 *                          is the only case where "go and get some" is useful
 *                          rather than noise.
 */
export function handoffLinks({
  vault,
  owner,
  token,
  // ft_metadata's symbol. Mainnet USDC's account id is a 64-character hex
  // string, so naming the token by id turns a helpful sentence into noise.
  // Falls back to the id when a token has no symbol.
  symbol,
  network,
  canFundFromOwner,
  agentIds = [],
}) {
  const name = symbol || token;
  const base = EXPLORER[network] ?? EXPLORER.mainnet;
  const acct = (id) => `${base}/accounts/${id}`;
  const links = [];

  links.push({
    label: `Your vault: ${vault}`,
    url: acct(vault),
    why: "the contract, its balance and every payment it has made — check it rather than taking this output's word for it",
  });
  links.push({
    label: `Your owner account: ${owner}`,
    url: acct(owner),
    why: "the account that controls the vault and paid for it; its key is the one worth protecting",
  });

  // De-duplicated: the same agent passed twice is clutter, not two links.
  for (const id of [...new Set(agentIds)]) {
    links.push({
      label: `Agent: ${id}`,
      url: acct(id),
      why: "confirm its one key is function-call only and pinned to the vault — that restriction is the whole safety story",
    });
  }

  // Only when they cannot fund from the owner, and only where the rail exists.
  // Intents is mainnet-only (packages/mcp/src/quote.ts:27), so pointing a
  // testnet user at a mainnet swap UI wastes their time and teaches them the
  // product is broken.
  if (canFundFromOwner === false && network === "mainnet") {
    links.push({
      label: `Get ${name}`,
      url: "https://near-intents.org/",
      why: `swap almost any asset into ${name} on NEAR; send the result to ${owner}, then re-run with --fund <amount>`,
    });
    links.push({
      label: "Bridge from Ethereum",
      url: "https://rainbowbridge.app/",
      why: "if the funds you want to move are already on Ethereum",
    });
  }

  return links;
}

/** The lines the wizard prints. Label, reason, then the URL on its own line. */
export function handoffLines(links, dim = (s) => s) {
  const out = [];
  for (const l of links) {
    out.push(`${l.label}`);
    out.push(dim(`  ${l.why}`));
    out.push(`  ${l.url}`);
    out.push("");
  }
  return out;
}
