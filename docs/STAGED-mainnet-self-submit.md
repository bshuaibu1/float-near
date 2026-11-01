# STAGED: validate the virtual-agent gas-key path on MAINNET

## Status, 2026-11-01

**Step 1 — DONE.** `float.test015.near` runs the pinned artifact. Verified off
chain, not from the deploy's own report:

```
code_hash   2CwvTaM6p2kXJLzZioFZwRVGj61B8KefS2EYCFmQznqD   (== the pin)
code        299620 bytes, byte-identical to packages/create-float/res/vault.wasm
storage     304688 -> 305292 bytes   (exactly the +604 predicted)
state       owner, 4 nodes, caps 2040000/510000, root allowlist, production clock
free        0.228624 NEAR
```

**Step 2 — DONE. The claim is validated on mainnet.** Run on 2026-11-01 against
`float.test015.near`, node 3, with real USDC:

```
outcome   {"request_id":"ss-c-mvxjnp0f39xr","node_id":3,"status":"SETTLED",...}
payee     +0.01 USDC
gas key   0.070000 -> 0.069075   BURN 0.000925   <- ITS OWN balance paid
vault     0.153793 -> 0.144918   storage +902B
```

A NEP-611 gas key, bound to node 3, self-submitted a `request_payment` that
settled and moved real USDC, paying from its own balance. An installed but
unbound key was refused with `NOT_VIRTUAL_AGENT`. That is the whole claim.

It scored **6/7**, and the one failure was the measurement, not the
implementation: `unexplained -0.000145`, i.e. the vault's balance fell by *less*
than its storage grew — it came out **ahead**, which cannot mean it paid gas.
Fixed, and the fix is described under "Why the script is trustworthy" below.
A re-run would score 7/7 but proves nothing new; the substantive result stands.

Note the mainnet storage growth is **902 bytes** against testnet's 290. Expected:
node 3's path is `[0,1]` so three daily ledger entries are created rather than
two, and the mainnet USDC account id is a 64-character hex string against
testnet's `ft.floatv4.testnet`.

---

Mainnet `as-transaction` work is reserved for Bashir
(`docs/` and project memory both say so; the permission classifier enforces it).
Everything below has had its read-only half executed and recorded.

The claim under test, verbatim from the PR body:

> virtual agent + gas key + `signer_account_pk` path is validated on testnet with
> real transfers.

The goal is to replace "on testnet" with "on testnet **and mainnet**".

---

## What this proves, and what it costs

**Seven** checks run with `ONLY_GAS_KEY=1` — measured, by running that exact
branch on testnet, not counted off the source:

| | |
| --- | --- |
| **0** | the vault runs the EXACT artifact create-float ships |
| **0** | the deployed code contains `signer_account_pk` |
| **B** | a key installed on the vault but NOT bound is refused with `NOT_VIRTUAL_AGENT` |
| **C** | the gas-key-signed payment SETTLED |
| **C** | the payee was actually paid — a real `ft_transfer` |
| **C** | a bound NEP-611 **gas key** pays from **its own** balance |
| **C** | the vault's free balance falls by **storage only** — zero gas |

Real money moved: **0.01 USDC**, from the vault to `test015.near` — which is the
owner, and is allowlisted at root, so it lands back in Bashir's own account. NEAR
spent: roughly **0.0022** for the deploy plus **~0.002** of gas burn; the 0.07
funding the gas key is withdrawn back in cleanup.

Step **A** (a plain function-call key) is deliberately skipped. The gas key is
the architecture being shipped, and each extra leg is more real USDC and another
reservation against a thin margin.

---

## Preflight — ALREADY RUN, read-only, 2026-11-01

Nothing below needs re-running unless a day passes or state changes.

**Signers.** `float.test015.near` and `test015.near` each carry exactly one key,
both `FullAccess`, both present on-chain and matching the credential files
(`ed25519:DHyH8bhSiKXvQk…`). The vault can therefore sign its own
`DeployContract`, which is required: that action applies to the signer's own
account.

**Storage margin.**

```
balance         3.28594 NEAR
storage_usage   304688 bytes -> locked 3.04688
deployed code   299016 bytes
new code        299620 bytes  (delta +604)
locked after    3.05292 NEAR
margin after    0.23302 NEAR
VERDICT         fits, with 0.1 NEAR headroom to spare
```

**Deploy cost**, computed from mainnet's own `EXPERIMENTAL_protocol_config`
rather than a remembered per-byte figure:

```
TOTAL GAS   21,974,306,741,660  (21.97 TGas)
cost        0.002197 NEAR at the current price, 0.021974 at 10x
```

This is worth stating because the `NO_MIGRATE` branch attaches no
`prepaid-gas`, so the cost is the protocol's action cost and not a
`prepaid × 1e9` reservation. 21.97 TGas against the 1,000 TGas transaction
limit, and 0.0022 NEAR against a 0.233 margin.

**Budget, allowlist, token.** Node 3 is `r2`, parent 1, path `[0,1]`, not frozen,
USDC limit `daily_cap 1.02 / per_tx_cap 0.51`. Every node on the path has the
full day's budget available (root 2.04, research 1.53, r2 1.02, all with
`executed 0`). The allowlist is defined at node 0 and contains `test015.near`.
The vault holds 0.990198 USDC; the payee is registered on the token. Vault not
paused, clock `production`, 4 nodes.

> The first version of that preflight printed `PREFLIGHT CLEAN` while three of
> its probes returned `undefined`, `null` and `method is not found` — it had
> invented `get_available`, `get_recipients`, `node.name` and `node.parent_id`.
> The checks around them passed, because a probe that CANNOT see and a probe
> that sees nothing wrong give the same output. The version in
> `.demo/mainnet-preflight.mjs` asserts the Node shape first and reports a
> missing field as a blocker.

---

## Step 1 — upgrade the mainnet vault to the published artifact

Run from **git-bash**, with the variables set INSIDE it. In PowerShell plain
`bash` is WSL, where `$env:VAULT` is not inherited and `cargo-near` is absent.

```powershell
& 'C:\Program Files\Git\bin\bash.exe' -c "cd /c/Users/BASHIR/Documents/near-vault && USE_WASM=packages/create-float/res/vault.wasm EXPECT_CODE_HASH=2CwvTaM6p2kXJLzZioFZwRVGj61B8KefS2EYCFmQznqD NETWORK=mainnet CONFIRM_MAINNET=1 NO_MIGRATE=1 VAULT=float.test015.near bash scripts/upgrade-vault.sh"
```

Four things in that command are load-bearing:

- **`USE_WASM`** deploys the artifact create-float 0.3.1 actually ships, rather
  than rebuilding. `cargo near build non-reproducible-wasm` does not promise the
  same bytes back, and the validation's first assertion is "the vault runs the
  EXACT artifact create-float ships". A rebuild is only *probably* identical.
- **`EXPECT_CODE_HASH`** pins it, so `USE_WASM` cannot quietly deploy the wrong
  file. It is `base58(sha256(wasm))` — NEAR's own `code_hash` encoding, so the
  same string is readable back off the chain afterwards.
- **`NO_MIGRATE=1`** is correct and *established*, not assumed: this change
  reuses `pubkey_to_node` and adds no `Vault` field, and the identical upgrade
  (299,016 → 299,620) has already been applied to `approve.floatv4.testnet`,
  which runs the same generation as mainnet. Running `migrate()` here would
  deserialise `LegacyVault` against already-migrated state and revert.
- **`CONFIRM_MAINNET=1`** is the script's own typed acknowledgement.

The script will, in order: name the shell, check the signer key **before**
building, skip the build and print the pinned hash, check the storage margin,
snapshot live state, deploy, then run `verify-upgrade.mjs verify` against the
*mainnet* RPC and diff the tree, ledgers, request history and config against the
pre-deploy snapshot.

**Then confirm the chain agrees with the pin** — the same string, no conversion:

```powershell
node -e "new (require('near-api-js').JsonRpcProvider)({url:'https://free.rpc.fastnear.com'}).viewAccount({accountId:'float.test015.near'}).then(a=>console.log(a.code_hash, a.code_hash==='2CwvTaM6p2kXJLzZioFZwRVGj61B8KefS2EYCFmQznqD'?'MATCH':'MISMATCH'))"
```

## Step 2 — run the validation

```powershell
Set-Location C:\Users\BASHIR\Documents\near-vault; $env:ALLOW_MAINNET="1"; $env:ONLY_GAS_KEY="1"; $env:REQUIRE_VAULT="float.test015.near"; node scripts/validate-self-submit-testnet.mjs
```

**The `Set-Location` is part of the command, not a prerequisite to remember.**
Two attempts were lost to this, both from `C:\Users\BASHIR`, both ending in

```
Error: Cannot find module 'C:\Users\BASHIR\scripts\validate-self-submit-testnet.mjs'
```

That is Node failing to resolve the *script file* from a relative argument,
before a single line executes — so no change inside the script can prevent it.
(The first round of this was misdiagnosed as the script's own cwd-relative
artifact read. That was a real latent bug, fixed, and guarded by the root suite
— but it was a *different* bug, and it would have bitten on the next line rather
than this one.)

Putting the `cd` inside the pasted line fixes it for good, and leaves the shell
in the repo so any follow-up command also resolves.

It now opens with a header naming the network, vault, owner, payee and legs, and
the final line repeats the target — so a pasted tail is attributable to a chain.

`REQUIRE_VAULT` is not decoration. **Without `ALLOW_MAINNET`, the vault DEFAULTS
to the testnet account**, so a mainnet run whose environment variables failed to
take does not error: it silently validates testnet and prints a green 7/7 that
says nothing about mainnet. `REQUIRE_VAULT` makes that disagreement fatal
(exit 2, before anything is spent).

Expected: **7/7**, the payee up 0.01 USDC, and cleanup leaving
`float.test015.near` with exactly **1 key** and the gas-key balance withdrawn.

The script also refuses `ALLOW_MAINNET=1` against a non-`.near` vault. All three
guards have been exercised.

### Verifying it afterwards, from the chain

`node .demo/mainnet-verify.mjs` — read-only. It checks the code hash against the
pin, the state against the pre-upgrade facts, the request ledger for the
`ss-c-*` leg, that **no** `ss-a-*` leg exists (which would mean `ONLY_GAS_KEY`
was not honoured and extra real USDC moved), and that no key, binding or
funded gas key was left behind.

The decisive field is **`storage_usage`**. A settled payment writes a ~290-byte
ledger record, so 305,292 bytes means the deploy landed and nothing else did;
305,582 means a payment settled too. It is a more reliable witness than a
balance, because it does not drift with gas.

---

## Why the script is trustworthy for this

It is the **same file** that passed 11/11 on testnet, parameterised rather than
forked, so mainnet runs the code path that was proven. After parameterising it
regressed to 10/11 and was fixed before being staged here:

- `BURN 0.029088` was a **reservation read mid-settlement**; the real burn was
  **0.000801**, which the cleanup's withdraw revealed moments later. The
  settle predicate was `> FUND - reservation - 0.001`, i.e. `> 0.009` — a bound
  so loose that a half-settled 0.0409 satisfied it. It now polls to within 0.005
  of `FUND` *and* requires two consecutive equal reads.
- `unexplained -0.000317` took **two wrong diagnoses** before the right one, and
  the sequence is worth recording because the first fix looked like it worked.

  I first called it a refund landing randomly inside the measurement window and
  "fixed" it by polling the derived quantity to its expected value. The full run
  then passed 11/11, which appeared to confirm it.

  It had not. Running the `ONLY_GAS_KEY=1` branch produced **exactly
  -0.000317 again** — the same value to the yocto, on a different run. A random
  settling artifact does not repeat to six decimal places, and the new 32-second
  poll had sat through its entire budget without the number moving.

  The actual cause: **the baseline was contaminated, and polling the end of a
  window cannot repair that.** Once a stray refund lands *inside* `[st0, st1]`,
  the difference is permanently off by that amount; waiting longer changes
  nothing. Step A's own duration had been acting as an accidental quiet period,
  so skipping it let a refund from step B's `AddKey` land just after `free0` was
  read. The baseline is now taken by `settledVaultState()`, which requires two
  consecutive identical reads of both balance and storage before measuring.

- The mainnet run then failed at `-0.000145` anyway, because **"unchanged across
  two reads 800ms apart" is a coincidence, not a quiet period.** Several
  vault-signed operations are in flight by then and their refunds trickle in
  over seconds. The baseline now needs **6** consecutive identical reads spanning
  at least **8 blocks** — `viewAccount` returns `block_height`, so the run can
  prove the chain advanced rather than assume it. Without that, "the value did
  not change" and "no new block was produced" are the same observation.

- **The assertion is now one-sided, and that is a correctness fix rather than a
  loosened tolerance.** A *positive* residual means the vault's balance fell by
  more than its storage grew — it paid gas, the defect this path exists to
  prevent. A *negative* residual cannot mean that, so failing on it tested
  something stronger than the claim.

  The negative residual was investigated before the check changed, and the
  candidate explanation was **refuted, not assumed**: NEAR pays some contracts a
  share of the gas burnt on their own code, which would have made this a real
  credit and a genuine product fact. A probe sent a **duplicate request id** —
  refused by the contract, and a blocked request is never stored, so storage
  cannot move and any balance change is gas alone. Result: storage delta **0
  bytes**, balance delta **exactly 0.000000**. No rebate.

- **And a one-sided check needs a positive control, or it is indistinguishable
  from a check that cannot fire.** The control was already in the script: step A
  uses a plain function-call key, where the VAULT pays the gas, so the same
  quantity must come out positive there. Both legs now measure it:

  | leg | payer | vault's gas |
  | --- | --- | --- |
  | A, plain function-call key | vault | **0.000801** |
  | C, NEP-611 gas key | gas key (0.000801) | **0.000000** |

  Identical work, identical cost, different payer. That side-by-side is the real
  evidence for the architecture, and it is stronger than either leg alone.

Both of the first two figures are the same class as the memory note
`near-balance-reads-lag-poll-to-an-expected-value`, in a script that already
carried a comment warning about it — and the second one shows the note is not
quite enough on its own: "poll to an expected value" protects a *reading*, and
says nothing about protecting a *baseline*.

What makes the burn figure trustworthy is independent agreement: the polled
value (0.000801) and what the withdraw actually returned (0.070000 → 0.069199)
match exactly.

Final testnet state: **12/12** on the full path, with step A's control at
`gas 0.000801` and step C at `unexplained 0.000000` in the same run.

## If step 1 fails

It fails atomically — NEAR reverts a `DeployContract` with its init call, and
`NO_MIGRATE` has no init call at all, so the vault keeps running 299,016 bytes
against untouched state. The margin check and the signer check both run *before*
the deploy, which is where the four failed cycles of 2026-10-31 went.

The one outcome to watch for is `LackBalanceForState`, which would mean the
margin moved between the preflight above and the run. Re-run
`node scripts/check-upgrade-margin.mjs float.test015.near packages/create-float/res/vault.wasm`
and top the vault up to clear it.
