# Spike: NEP-611 gas keys remove the agent sub-account

> **On the scripts named below.** They were instruments, and they have been
> pruned from `scripts/` now that their answers are recorded here. The
> measurements stand; the tools are in git history. See `scripts/README.md`
> for how to read one back.


Status: **answered, and CONFIRMED ON MAINNET 2026-10-31.**
Testnet (protocol 88) with `scripts/spike-gas-key.mjs` against the 1,081-byte
`no_std` probe from `SPIKE-self-fc-key-2026-10-31.md`; mainnet (protocol 86) with
`scripts/mainnet-gas-key-test.sh`, run by Bashir.

## MAINNET RESULT — the whole thing cost 0.000370 NEAR

Four transactions on `test015.near`. The live vault was never a signer; the key
was function-call restricted to one read-only view method on it.

```
before                     free 0.178927   1 key    gas key: none
[1] add gas key            ACCEPTED        own balance 0.000000  (empty, as documented)
[2] fund 0.05              gas key 0.000000 -> 0.050000
                           acct free 0.176638 -> 0.126580
[3] call, signed by it     gas key 0.050000 -> 0.049836   <- paid
                           acct free 0.126580 -> 0.126580   <- UNTOUCHED
[cleanup] withdraw+delete  recovered 0.049836, key removed
after                      free 0.178557   1 key    gas key: none
```

Verified independently off chain afterwards rather than from the script's own
output: `free=178557464374003699999987`, `gas=none`, `keys=1`.

So on mainnet, at protocol 86:

- **`AddGasKey` is accepted.** This was the one unverified assumption behind the
  whole architecture choice.
- **The gas key's own balance pays** — 0.000164 for a 30 TGas call — and the
  account's free balance did not move by a single yocto.
- **The float is recoverable.** `withdraw-from-gas-key` returned 0.049836.

### Correcting the headline this spike first gave

The first write-up — and the script's own verdict line — said an agent costs
"~0.05 recoverable instead of 0.55 stranded". **That reads the wrong number off
this run.** The 0.05 only sufficed because the test used **30 TGas**, whose
reservation is ~0.0309. A gas key's balance must clear the reservation, which is
`prepaid_gas × 1e9`:

| prepaid | reservation floor |
| --- | --- |
| 30 TGas | 0.0309 |
| 50 TGas (`MIN_GAS_FOR_DISPATCH`) | 0.0515 |
| **100 TGas (`DEFAULT_GAS_TGAS`, what `request_payment` actually uses)** | **0.1009** |

Burn per call is separate and small: 0.000164 measured here for a trivial view
call, and ~0.00107 per *real* mainnet payment (from `r1`'s key, three payments
consuming 0.003221). So payments affordable ≈ `(balance − floor) / 0.00107`:

| gas key funded | at 100 TGas | at 50 TGas |
| --- | --- | --- |
| 0.15 | ~45 payments | ~92 |
| 0.25 | ~139 | ~186 |
| 0.55 | ~420 | ~466 |

**So the honest claim is not "a tenth of the capital".** It is: *comparable
capital, but recoverable instead of stranded, with no sub-account and no
contention* — plus a lever, since dropping `DEFAULT_GAS_TGAS` from 100 to ~60
would nearly halve the floor.

That is the third number I have had to correct today after stating it (the
others: the allowance reservation being "permanently deducted", and the per-vault
cost under global contracts). The pattern is the same each time — a figure
measured under one set of parameters quoted as if it were general.

### A flaw in the staging itself

The run used `sign-with-plaintext-private-key`, and near-cli-rs echoed a
"console command if you need to re-run" line **containing the full private key**,
into the operator's scrollback and a chat transcript. Harmless this time: the key
was a throwaway, restricted to one read-only method, and deleted minutes later —
confirmed off chain. But the pattern leaks whatever key it is given, and a script
like this gets copied. `mainnet-gas-key-test.sh` now writes a temporary
access-key file and uses `sign-with-access-key-file`, so the **path** is what
gets echoed, and the cleanup deletes it.

## The question that prompted it

"Why do we need agent accounts when we are going to be using virtual agents?"

The honest first answer was: **virtual agents do not remove the account, they
move it.** A virtual agent is raw keypair bytes, not a NEAR account, and gas is
paid by whoever signs the transaction — `request_payment_signed`'s own doc
comment says "the caller is only a relayer paying the gas". So without a relayer
somebody funded must submit, and if that somebody is the agent, you are back to
a sub-account.

That was true, and it was also incomplete. There is a fourth option.

## Gas keys (NEP-611), live on mainnet at protocol 86

An access key that holds **its own NEAR balance** for gas, fundable by anyone,
withdrawable back to the account, with up to 1,024 independent nonce lanes.
Mainnet is on 86 — the version this repo measured on 2026-10-31 — so this is
available now, not a roadmap item.

```json
{"GasKeyFunctionCall":{"allowance":null,"balance":"0",
  "method_names":["whoami"],"num_nonces":4,
  "receiver_id":"p1.floatv4.testnet"}}
```

Note `"allowance":null`. **For a gas key the balance IS the cap** — there is no
separate allowance to size, which removes the `MIN_AGENT_KEY_ALLOWANCE`
guesswork entirely.

## Results, 5 of 5

| | |
| --- | --- |
| **Q1** function-call gas key, restricted to one method on its own account | **accepted**, `num_nonces: 4` honoured |
| **Q2** does the key's OWN balance pay? | **yes** — see the discriminator below |
| **Q3** is `signer_account_pk()` still the agent's key? | **yes**, `00c7edcd…` matched a locally generated keypair exactly |
| **Q4** is the float recoverable? | **yes** — account free `0.017299 -> 0.082762` after `withdrawFromGasKey` |
| **Q5** do two keys contend for the account's balance? | **no** |

### The discriminator for Q2 and Q5

Funding a gas key *drains the account*, which makes the test design itself the
proof. Most of the account's free balance was moved into two gas keys:

```
account free 0.109566; funding each key 0.043826
account free is now 0.017299
ok   the account genuinely cannot cover one 30 TGas reservation  0.017299 < 0.030000
  gas key GsPz8M1S4RXY… holds 0.043826
  gas key 99Z4QSBmSrhh… holds 0.043826
2/2 executed, distinct blocks 1
```

**Two calls executed in one block while the account held less than a single
reservation.** There is nowhere else the gas could have come from.

The protocol says so in its own words too, with a distinct error class:

```
Not enough GAS KEY balance for p1.floatv4.testnet
  (balance: 0, cost: 30918885126219200000000)
```

`0.030919` at 30 TGas is the **identical** reservation measured for ordinary
keys in the previous spike. Same mechanism, different pot.

## Why this dominates the alternatives

| path | per agent | stranded? | contention | relayer? | contract change |
| --- | --- | --- | --- | --- | --- |
| (a) agent sub-account | 0.55 | **yes** — 10.7752 already stuck | none | no | 6-line recovery fix |
| (b) plain fn-call key on vault | 0 | no | **0.100919 per in-flight call** | no | `signer_account_pk` |
| (c) virtual agent + relayer | ~0 | no | none | **yes** | none |
| **(d) gas key on vault** | **~0.05, withdrawable** | **no** | **none** | **no** | `signer_account_pk` |

(d) wins on every axis, at the cost of the same contract change (b) needs:
`request_payment` must resolve the node from `env::signer_account_pk()` when
`predecessor_account_id() == current_account_id()`. The `pubkey_to_node` map
already exists, built for virtual agents.

**So the recovery fix and the allowance right-sizing are work on a path (d)
replaces.** The 10.7752 NEAR already stranded stays stranded either way — that
fix is forward-only — but adopting (d) means not adding to it.

This reverses the recommendation given an hour earlier in this repo's own
history, which was to skip the `signer_account_pk` change and do the 6-line
recovery fix instead. The reasoning then was sound on risk and wrong on payoff,
because it did not know gas keys existed.

## What a browser onboarding becomes

One wallet signature, targeting the new vault account:

```
CreateAccount
Transfer                    ~0.05 + the agent's gas float
UseGlobalContract           32-byte hash, not 292 KB
FunctionCall new(...)
AddFunctionCallGasKey       agent pubkey, receiver = vault, ["request_payment"]
TransferToGasKey            fund the agent's own gas pot
```

Then the agent is autonomous, nothing is stranded, and the user paid once.

## Not measured — do not build on these without checking

- ~~**Mainnet.**~~ **Done** — see the mainnet result at the top. The gap is
  closed.
- **`num_nonces` at scale.** 4 was honoured on testnet, 1 on mainnet; 1,024
  untested.
- ~~**Concurrency on mainnet.**~~ **Done** — see below.

## Concurrency CONFIRMED on mainnet

`scripts/mainnet-gas-key-concurrency.mjs`, 60 TGas, two gas keys on
`test015.near`:

```
[3] account free        0.04330    <- BELOW one 0.06092 reservation
    key 1 gas balance   0.06492
    key 2 gas balance   0.06492
    ok   account CANNOT cover one reservation; both keys CAN

[4] key 1: EXECUTED  block F2Ve54YxTSFC…
    key 2: EXECUTED  block F2Ve54YxTSFC…     <- SAME BLOCK

    2/2 executed, distinct blocks 1
```

**Both executed in one block while the account could not cover a single
reservation.** There is nowhere else the gas could have come from. Gas keys do
not contend on mainnet, so one vault can host many agents paying simultaneously.

60 TGas is forced, not chosen: the account must be unable to cover one
reservation while both keys can, which needs `R > free/3`. At 0.178 free that
is `R > 0.0595`, so prepaid > ~59 TGas; 100 TGas would need 0.210 of funding and
does not fit.

### The per-call cost that run printed is wrong by 358x

It showed `key 1 gas 0.06492 -> 0.00400`, i.e. 0.06092 per call — **exactly the
reservation**, because the reservation was still held when the line printed.
Cleanup then withdrew **0.06475** from each key, so the real burn is:

| | |
| --- | --- |
| funded per key | 0.06492 |
| withdrawn by cleanup | 0.06475 |
| **real burn per call** | **0.00017** |
| single-key mainnet run, for comparison | 0.000164 |

Whole run: account 0.17815 → 0.17521, **0.00294** total — of which 0.00034 was
the two calls and 0.00260 was gas for the eight account-signed transactions
(~0.000325 each).

The script now waits for the refund before quoting a cost, and says so
explicitly when it has not settled. The figure was dangerous precisely because
it matched the reservation to the yocto, which reads as a finding rather than
as a stale read.
- **That the agent cannot withdraw its own gas float.** `withdrawFromGasKey` is
  a distinct action type, not a `FunctionCall`, so a function-call key should be
  unable to sign it — the same reasoning that bars `DeleteAccount`. High
  confidence, **reasoned not measured**, and it is a security property, so it
  should be measured before shipping.

## One note on method

**near-api-js's TypeScript shape is misleading.** It suggests the gas balance is
nested under `gas_key_info`; the RPC puts it at the top level of the permission
variant. Reading the documented shape produced **five FAILED checks against a
protocol that was working correctly** — and the permission dump printed directly
beside those failures showed `balance:"0"` plainly. The probe had the answer on
screen while the parser reported not finding it.

The lesson is narrow and reusable: when a self-built check reports a failure,
the check is a suspect before the system is, and anything the probe printed
*next to* the failure is the first place to look.
