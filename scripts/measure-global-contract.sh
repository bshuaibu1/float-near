#!/usr/bin/env bash
# Measure what UseGlobalContractAction actually charges a user.
#
# docs/GLOBAL-CONTRACTS-NEP-591.md §4 marks this UNVERIFIED and warns that
# "zero onboarding cost" is too strong, because a vault still stakes for its own
# state even if it stops staking for code. This settles the code half with
# numbers instead of leaving it as a claim.
#
# THE INSTRUMENT IS DELIBERATELY TINY. The question is what an ACTION costs, not
# what a contract costs, and the action's price does not depend on what the code
# does. Measuring with the real vault would mean a global deploy of 280,249
# bytes at NEP-591's 10x rate -- about 28 NEAR, burned. A 49-byte module costs
# ~0.005 NEAR and answers the same question.
#
# THE DESIGN IS DIFFERENTIAL, AND THAT IS THE POINT. One account deploying
# normally and one referencing a global contract tells you the difference for
# ONE size. Two sizes, ~100x apart, tell you whether the user's cost depends on
# code size at all -- which is the actual V2 claim. If `use` storage is
# identical for a 49-byte and a 5 KB contract, it is size-independent, and the
# saving on the real 273.7 KiB vault is the whole 273.7 KiB.
#
# Usage:
#   PARENT=floatv4.testnet bash scripts/measure-global-contract.sh
#
# Costs roughly 2 NEAR of the parent's balance; most is refundable account
# stake, ~0.52 NEAR is the burned global deploys. Creates 4 throwaway
# sub-accounts and leaves them in place so the numbers can be re-read.
set -euo pipefail
cd "$(dirname "$0")/.."

: "${PARENT:?set PARENT to a funded testnet account you hold a key for}"
NET="network-config testnet sign-with-legacy-keychain send"
STAMP="${STAMP:-$(date +%H%M%S)}"

mkdir -p .demo
node scripts/tiny-wasm.mjs .demo/tiny.wasm

# Pad with a wasm CUSTOM section (id 0), which execution ignores but which
# counts toward the deployed byte length -- a second size with no behaviour
# change, so size is the only variable between the two runs.
node -e '
const {readFileSync,writeFileSync}=require("fs");
const base=readFileSync(".demo/tiny.wasm");
const want=5120, name=Buffer.from("pad");
const payloadLen = want - base.length - 5;
const sec=Buffer.concat([
  Buffer.from([0x00]),
  (()=>{let n=payloadLen+1+name.length,o=[];do{let b=n&0x7f;n>>>=7;if(n)b|=0x80;o.push(b);}while(n);return Buffer.from(o);})(),
  Buffer.from([name.length]), name, Buffer.alloc(payloadLen,0x41),
]);
const out=Buffer.concat([base,sec]);
writeFileSync(".demo/padded.wasm",out);
console.log(".demo/padded.wasm:",out.length,"bytes");
'

say() { printf "\n=== %s\n" "$*"; }
bal()  { near account view-account-summary "$1" network-config testnet now 2>/dev/null \
           | grep -oE "Native account balance *[0-9.]+" | grep -oE "[0-9.]+" | head -1; }
stor() { near account view-account-summary "$1" network-config testnet now 2>/dev/null \
           | grep -oE "Storage used by the account *[0-9.]+ *[KMG]?B" | head -1; }

mk() { # <name> — a fresh, equally funded sub-account so comparisons are clean
  near account create-account fund-myself "$1.$PARENT" '0.5 NEAR' \
    autogenerate-new-keypair save-to-legacy-keychain \
    sign-as "$PARENT" $NET >/dev/null 2>&1
  echo "$1.$PARENT"
}

say "parent balance before: $(bal "$PARENT") NEAR"

# ---- 1. publish both sizes as global contracts, and price the burn
for w in tiny padded; do
  before=$(bal "$PARENT")
  say "deploy-as-global ($w, $(wc -c < ".demo/$w.wasm") bytes)"
  near contract deploy-as-global use-file ".demo/$w.wasm" as-global-hash \
    sign-as "$PARENT" $NET 2>&1 | grep -iE "hash|success|error" | head -5
  after=$(bal "$PARENT")
  awk -v b="$before" -v a="$after" 'BEGIN{printf "    deployer paid: %.6f NEAR (includes gas; NEP-591 prices the code at 10x storage)\n", b-a}'
done

echo
echo "!! Record the two global code hashes printed above. The commands below"
echo "!! need them, and near-cli asks for the hash, not the file."

# ---- 2. the four accounts
say "control A: normal deploy of tiny"
A=$(mk "ga$STAMP"); near contract deploy "$A" use-file .demo/tiny.wasm without-init-call $NET >/dev/null 2>&1
say "control C: normal deploy of padded"
C=$(mk "gc$STAMP"); near contract deploy "$C" use-file .demo/padded.wasm without-init-call $NET >/dev/null 2>&1

cat <<EOF

Now run the two global-reference deploys by hand, substituting the hashes:

  B=gb$STAMP.$PARENT
  D=gd$STAMP.$PARENT
  near account create-account fund-myself \$B '0.5 NEAR' autogenerate-new-keypair \\
    save-to-legacy-keychain sign-as $PARENT $NET
  near contract deploy \$B use-global-hash <TINY_HASH>   $NET
  near account create-account fund-myself \$D '0.5 NEAR' autogenerate-new-keypair \\
    save-to-legacy-keychain sign-as $PARENT $NET
  near contract deploy \$D use-global-hash <PADDED_HASH> $NET

Then compare — this is the whole result:

  A (deploy 49B)    storage: $(stor "$A")
  C (deploy 5120B)  storage: $(stor "$C")
  B (use 49B)       storage: near account view-account-summary \$B ...
  D (use 5120B)     storage: near account view-account-summary \$D ...

READ IT LIKE THIS:
  * C minus A should be ~5071 bytes — the padding. That is the control proving
    a normal deploy charges the user for every byte of code.
  * If D equals B, the user's cost does NOT scale with code size, and the 273.7
    KiB the real vault stakes today goes away under a global contract.
  * If D minus B tracks the padding like C minus A does, the saving is NOT what
    the roadmap assumes, and §4 of the doc needs rewriting rather than ticking.
EOF
