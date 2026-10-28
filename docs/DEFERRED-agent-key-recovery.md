# Deferred: make agent-account deposits recoverable

**Status:** scoped, not implemented. Deliberately deferred until a vault runs on
mainnet, so the basic path is proven before changing the function that creates
funded accounts.

## The problem

Each agent account is created with 0.55 NEAR attached. Today that is stranded:
the account's only key is a function-call access key scoped to
`request_payment`, and such keys cannot sign `DeleteAccount`. No full-access key
for an agent account exists anywhere, so nobody can delete it or reclaim its
balance.

Exposure is ~0.55 per agent, not the ~0.05 storage stake. This was measured on
live testnet agents, and contradicted an earlier assumption that the gas float
was consumed by use:

| agent | balance | funded | burned |
| --- | --- | --- | --- |
| `r1` (busiest demo agent) | 0.9923 | ~1.0 | **0.0077** |
| `r2` | 0.9993 | ~1.0 | 0.0007 |
| `s0` | 0.5497 | 0.55 | 0.0003 |

Account storage is 253 bytes = 0.0025 NEAR, against the 0.05 allocated — 20x
padding.

The reason the float is untouched is in the `MIN_AGENT_KEY_ALLOWANCE` comment:
NEAR reserves the FULL prepaid gas of a call against the signer and refunds the
unused part, so a key needs ~0.5 NEAR of headroom to transact at all while
burning a tiny fraction. The 0.5 is working capital, not a fee.

## Why it must happen at creation

NEAR requires `actor_id == account_id` for `AddKey`, `DeleteKey` and
`DeleteAccount` — a parent cannot touch a child's keys. The exception is that
when a promise batch's FIRST action is `CreateAccount`, the remaining actions
act as the new account. That is exactly why the existing
`.create_account().transfer().add_access_key_allowance(...)` chain works.

So:

- adding a full-access key during `create_agent_account` works — one more
  action in a batch that already does this
- retrofitting an agent that already exists is **not possible from the
  contract**

This change is therefore **forward-only**. The 18 agents under
`v3.floatvault-12329.testnet` hold NEAR that stays stranded regardless.

Measured account-by-account on 2026-10-28 rather than estimated: **10.7752 NEAR
across all 18**, with 0 accounts unreadable — which is what makes the total
trustworthy, since a partial read would have silently under-reported it. An
earlier revision of this line said "~9.9 NEAR"; the real figure is ~0.9 higher.

    r1 0.9923   r2 0.9993   s0..s15  ~0.5485–0.5497 each

The restriction was confirmed by reading a live key, not inferred from the
design: `r1.v3.floatvault-12329.testnet`'s sole access key is
`only do ["request_payment"] function calls on v3.floatvault-12329.testnet with
an allowance of 0.4923 NEAR`. There is no full-access key on it, so it cannot
sign `DeleteAccount` — and retiring the parent vault does not change that. The
sub-accounts simply outlive it.

## Design: reuse the vault's own key

Register the VAULT's existing public key as a full-access key on each agent.
An access key is just a public key registered against an account, and one
keypair may be registered on many accounts.

- no new key material, nothing further for a user to lose
- `float-exit` already loads `credPath(vault)`; it can sign `DeleteAccount` for
  every agent with the key it has
- no new attack surface: whoever holds the vault key already controls limits,
  freeze, `withdraw` and agent creation

### Capability delta

| Actor | Before | After |
| --- | --- | --- |
| Owner / vault-key holder | limits, freeze, withdraw, agent creation | same, plus may impersonate an agent |
| The agent itself | function-call key, `request_payment` only | **unchanged** |
| Outsider | nothing | nothing |

Impersonating an agent means spending within that agent's budget, which the
owner can already do by re-pointing budgets or withdrawing outright. No
capability delta; the owner is the trust root.

**Documentation precision required.** "The agent's KEY may only call
`request_payment`" remains true. "The agent ACCOUNT may only call
`request_payment`" would become false. Current wording is already careful and
must stay that way.

## Changes

1. **Contract** `create_agent_account`, ~6 lines: new
   `recovery_public_key: Option<PublicKey>` param; when `Some`, append
   `.add_full_access_key(key)` to the existing batch. `Option` keeps it
   backwards compatible.
2. **Wizard**: pass `vaultKey.getPublicKey()`.
3. **float-exit**: sign each agent's `deleteAccount(vault)` with the vault key
   rather than searching for a per-agent key.

## Tests

1. The agent's own key still cannot do anything but `request_payment` — the
   existing guarantee must not regress.
2. The recovery key CAN delete an agent, refunding to the vault. Needs a
   sandbox test, which per project notes requires Linux/WSL. This one must
   actually run; it is the whole point of the change.
3. `recovery_public_key: None` behaves byte-identically to today.
4. A mutation proving which clause carries test 1, so a passing negative test
   is not passing for the wrong reason.

## Risk

Low and additive, with one caveat: this touches the only function that creates
funded accounts, where a mistake mints or strands money. Test 2 must be
executed, not deferred.

Recovers ~0.55 per agent. At ten agents per user, 5.5 NEAR per customer moves
from stranded to refundable.
