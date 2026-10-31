# Spike: can an agent hold a function-call key on the VAULT itself?

Status: **answered, yes — with one sizing constraint nobody predicted.**
Measured on testnet 2026-10-31. Instruments: `scripts/spike-self-fc-key.mjs`,
`scripts/spike-allowance-rate.mjs`, `scripts/spike-min-allowance.mjs`,
`contracts/signer-probe/`.

## The design under test

Replace `request_payment_signed` + a gas relayer with: an access key **on the
vault**, restricted to `request_payment`, carrying a NEAR `allowance`. The agent
submits its own transactions and pays its own gas, metered by the protocol.

Motivation, in order of size:

- **No relayer.** No service to run, no reimbursement path, and no need for the
  contract to pay anyone. The obvious alternative — reimburse a relayer from the
  vault *before* the budget tree is evaluated, so refused requests still pay —
  reintroduces **F2** ("an agent could drain the vault's NEAR, which no cap
  governed"), because `NEAR_BUDGET` is enforced *inside* that tree.
- **No agent sub-account.** 0.55 NEAR per agent (0.5 key allowance + 0.05
  storage) becomes the key's storage, ~0.0001.
- **No signature layer.** No nonce, no deadline, no `ed25519_verify`, no replay
  window — the protocol authenticated the key before the contract ran.
- **`allowance` is a second budget NEAR enforces for free.**

It rested on three protocol facts this repo had never tested.

## The instrument

A **993-byte** `no_std` probe with no near-sdk, declaring seven host functions
as externs and calling them directly. Two reasons, and both earned their place:

- **Cost.** With near-sdk the same probe was 88.2 KB, staking 0.904 NEAR. These
  testnet accounts hold 2.692 NEAR of *free* balance scattered over five
  accounts, the largest single pool being 1.074 on the virtual-agent proving
  ground — the one account that should not be stripped. The first run died with
  `LackBalanceForState` funding a sub-account from a vault whose 3.298 NEAR
  balance is 3.085 **locked**.
- **Method.** The questions are about host functions. Nothing should sit between
  the measurement and the thing measured — near-sdk silently substituting
  pure-Rust fallbacks for host functions is the exact class of surprise this
  repo has already been bitten by (see the root `Cargo.toml` note on
  `panic_utf8`). Verified with `scripts/wasm-imports.mjs`: exactly 7 `env`
  imports, nothing else.

## Results: 16/16

### Q1 — does the protocol accept a self-referencing function-call key? **Yes.**

```json
{"FunctionCall":{"allowance":"50000000000000000000000",
  "method_names":["whoami","burn"],
  "receiver_id":"p1.floatv4.testnet"}}
```

`receiver_id` is the same account the key lives on. Read back off chain, not
assumed from the AddKey succeeding.

### Q2 — can it sign, and does gas come from the allowance? **Yes.**

### Q3 — can the contract tell which agent called? **Yes, by public key only.**

```
control (full-access key): p1.floatv4.testnet|p1.floatv4.testnet|p1.floatv4.testnet|00ca776f…56e3
agent   (restricted key):  p1.floatv4.testnet|p1.floatv4.testnet|p1.floatv4.testnet|00f771cd…6243
                           current           |predecessor       |signer            |signer_account_pk
```

`current_account_id`, `predecessor_account_id` and `signer_account_id` are **all
the vault**. The only thing that differs is `signer_account_pk()`, and it is
exactly the key that signed — compared against a keypair generated locally, not
against whatever the chain echoed.

**So the contract must identify agents by public key** — which is precisely what
`pubkey_to_node` already does for virtual agents. The lookup exists.

### The restrictions are real, not decorative

```
deposit attempt        Deposit is not allowed with function call
other receiver         Access key receiver p1.floatv4.testnet does not match
                       transaction receiver ft.floatv4.testnet
unlisted method        Access key does not allow method get_calls
```

## The sizing constraint nobody predicted

**The first call of a key costs the reservation; every call after it costs only
what it burns.** Re-measured on a funded account at `final` finality, five
identical 30 TGas calls on one key:

```
call | allowance after | spent this call | tokens_burnt | spent/burnt
   1 |        0.119081 |        0.030919 |     0.000124 |      249.32
   2 |        0.118957 |        0.000124 |     0.000124 |        1.00
   3 |        0.118833 |        0.000124 |     0.000124 |        1.00
   4 |        0.118709 |        0.000124 |     0.000124 |        1.00
   5 |        0.118585 |        0.000124 |     0.000124 |        1.00
```

0.150000 − 0.030919 = 0.119081 exactly, and 0.030919 is the 30 TGas reservation.
So the reservation is deducted **once, on first use**, and is not returned to the
allowance; subsequent calls draw their real cost. Sizing a key is therefore
`reservation + calls × per-call-cost` — about 0.113 NEAR for a hundred 100 TGas
calls, not 0.0124.

**This corrects an earlier reading in this document's own first draft**, which
called the 0.030919 a finality artefact. There were two separate phenomena and I
had conflated them: this one-time deduction is real and reproducible at `final`
finality, while a *second* effect — an allowance appearing to go **up** by
0.030671 mid-run — was genuinely an optimistic-finality artefact. Only the
second one went away when the reads were fixed.

**But the protocol RESERVES far more than it spends, and the reservation is
charged against the key.** Measured by bisection:

| prepaid gas | minimum allowance that executes |
| --- | --- |
| 30 TGas | fails at 0.025, **works at 0.031** |
| 100 TGas | fails at 0.09 (`NotEnoughAllowance`) |

The reservation tracks `prepaid_gas × 1e9` — ten times the current gas price of
`1e8`, i.e. the protocol appears to reserve at the **maximum** gas price, not the
current one. Below it the call is rejected with `NotEnoughAllowance` even though
the real cost is 250× smaller.

### What that means for Float

`request_payment` requires ≥50 TGas (`MIN_GAS_FOR_DISPATCH`, and the guard is
`<` not `<=`, so exactly 50 settles) and the MCP server sends 100. So:

- an agent key needs **~0.1 NEAR of allowance** at 100 TGas, ~0.05 at 50;
- the vault needs that much **free (unlocked)** balance for a call to clear.
  The live mainnet vault's margin is 0.239, so it already would.

Still cheaper than the 0.55 NEAR sub-account, but **5.5× not 500×**, and the
headline should say so.

**An allowance is a spending LIMIT on the account's balance, not a segregated
deposit** — so provisioning a key does not lock 0.1 NEAR; it costs the key's
storage. Measured directly: a key was given a **1.0 NEAR allowance on an account
with 0.09 of free balance**, and the allowance was recorded in full.

## Concurrency: agents DO contend, and the number is 0.100919

Measured with `scripts/spike-allowance-concurrency.mjs`. N agents, one
restricted key each, 100 TGas, all pre-signed and then broadcast together:

| N concurrent | executed | distinct blocks |
| --- | --- | --- |
| 2 | **2/2** | 1 |
| 4 | **4/4** | 1 |
| 8 | **6/8** | 1 |

All six landed in **one block**, so the overlap was real rather than serialised.
The two rejections name the number outright:

```
Not enough balance for p1.floatv4.testnet
  (balance:  94043528796161400000000   = 0.094044 NEAR)
  (cost:    100918885126219200000000   = 0.100919 NEAR)
```

So **each in-flight call reserves 0.100919 NEAR of the account's balance**, held
until execution and then released. That is `prepaid_gas × 1e9` (the max gas
price, ten times the current 1e8) plus ~0.0009 of execution cost — the same
model the allowance floor follows. 0.683254 free / 0.100919 = 6.77, and 6 fit.

**Sequential agents do not contend**, once the refund has settled.

### What this costs the product

- The ceiling on **simultaneous** payments is `free_balance / 0.100919`, not the
  number of agents. Ten agents taking turns are fine; three at once need ~0.31
  of free NEAR.
- **This is the finding that revises the global-contracts plan.**
  `DECISION-ux-before-global-contracts.md` assumes "~0.05 NEAR all-in per vault"
  under NEP-591 (0.0436 stake + gas). A vault funded at 0.05 has ~0.006 free —
  **not enough for even ONE 100 TGas payment.** A vault whose agents actually
  transact needs roughly **0.1–0.2 NEAR of free balance on top of its storage
  stake**, which takes the "~1,439 vaults per 100 NEAR" line closer to ~600.
  Still a large win over 33, but the headline figure was for a vault that
  cannot pay.
- **Prepaid gas is the lever**, and it is linear. MCP sends 100 TGas;
  `MIN_GAS_FOR_DISPATCH` is 50. Dropping to ~60 would cut the per-call
  reservation by ~40%. **Untested** whether 60 TGas completes a real
  `ft_transfer` promise chain — a lever, not yet a recommendation.

## Two notes on method, because both nearly produced a wrong answer

**Optimistic finality manufactured a number — but only one of the two I blamed
on it.** Call 5 of one run showed the allowance going **up** by 0.030671, which
was a genuine artefact and disappeared under `finality: "final"`. The
0.030919 on the *first* call of a key, which I attributed to the same cause, is
real and reproducible on a funded account at final finality — it is the
one-time reservation deduction described above. Two phenomena, one explanation,
and the explanation only covered one of them.

**A mean over six samples flipped a conclusion five samples supported.** One
transient of 0.030919 against four identical rows of 0.000124 dragged the mean
to 0.006283, which cleared my own "is it prepaid?" threshold and made the script
print `VERDICT: the allowance is charged for PREPAID GAS` — the opposite of what
the data said. The summary statistic was the bug, not the data. A verdict that
one bad read can flip is not a measurement.

**A broken status lookup printed a confident, bolded, wrong conclusion.** The
first concurrency attempt used `sendTransactionAsync` for "genuine" overlap.
It returns `{final_execution_status: "NONE"}` with **no transaction hash**, so
the hash extraction yielded undefined, every status poll came back empty, and
both calls were recorded as failed. The script then printed `contention
observed` and a bolded INTERPRETATION asserting that N agents need N
reservations — a conclusion resting entirely on my own broken check, and one
that happened to be *true*, which is worse, because nothing would have caught
it. Rewritten to use `sendTransaction`, which returns the full outcome, and to
report the distinct block count so "concurrent" is a measured fact.

**The first two concurrency runs measured an empty account, not the protocol.**
The probe sat 0.0014 NEAR from its own threshold — agent 1 succeeded at 0.091908
of free balance, agent 2 failed at 0.090515 — so every reading was dominated by
edge effects and a partly-settled refund. On that evidence the summary line read
"the account's free balance DOES bind the reservation". After a 0.6 NEAR top-up
the same test reported the opposite, and *both* were artefacts: the real
mechanism is the per-call reservation above. A measurement taken at the edge of
the thing being measured is not a measurement.

**Awaiting a transaction is not awaiting its refund.** The sequential control
ran agent 2 straight after awaiting agent 1 and agent 2 failed short by
0.01087 — exactly agent 1's outstanding reservation. The control was not
sequential in the only sense that mattered, so a concurrent failure could not
have been attributed to concurrency. Fixed by polling free balance back to a
settled value between calls.

**Slicing an error message to 100 characters cut the answer in half.** The
`cost:` figure that is the entire result of the concurrency sweep was truncated
mid-number on the first run.

## Recommendation

Build this path, and keep `request_payment_signed` + relayer as the *second*
path for agents that cannot hold a key or submit transactions. It is already
built, already gas-measured, and the contract already documents the relayer as
untrusted — it just should not be the default.

Contract work required: `request_payment` must resolve the node from
`env::signer_account_pk()` when `predecessor_account_id() == current_account_id()`,
falling back to the existing account-based lookup otherwise. The pubkey→node map
already exists.

Do **not** build in-contract relayer reimbursement. It reintroduces F2, it
erodes the same storage margin the request history needs, and under global
contracts — where the vault deliberately holds almost no NEAR — it fights the
cost model it is meant to serve.
