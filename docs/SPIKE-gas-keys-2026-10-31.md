# Spike: NEP-611 gas keys remove the agent sub-account

Status: **answered — gas keys dominate every other agent-gas option.**
Measured on testnet (protocol 88) 2026-10-31 with `scripts/spike-gas-key.mjs`
against the 1,081-byte `no_std` probe from `SPIKE-self-fc-key-2026-10-31.md`.

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

- **Mainnet.** Tested on testnet protocol 88. Gas keys landed at 86 and mainnet
  is on 86, so it should work, but it has **not** been tested there. Four failed
  mainnet deploys this week all came from assuming a testnet result transfers.
- **`num_nonces` at scale.** 4 was honoured; 1,024 untested.
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
