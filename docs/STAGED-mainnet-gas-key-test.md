# Staged for Bashir: test NEP-611 gas keys on MAINNET

**Why staged and not run:** project memory, `mainnet-vault-float-test015.md` —
*"anything `as-transaction` on mainnet has to be run by Bashir. Do not look for a
workaround — stage the exact command and hand it over."* The same gate fired
twice while preparing this, including on a `--help` invocation that merely
contained a mainnet account name.

## What is already settled read-only, and what is not

Read-only evidence that gas keys are live on mainnet:

| check | mainnet (86) | testnet (88, known live) |
| --- | --- | --- |
| `view_gas_key_nonces` on a plain key | `UNKNOWN_GAS_KEY` — *"Gas key … does not exist"* | **identical** |
| `gas_key_host_fns` in runtime config | present | present |
| `action_creation_config` entries | 11 | 11 |

The mainnet node clearly *understands* gas keys: it answers with a gas-key
specific error class rather than an unknown-request-type. But that is the **view
layer**. Nothing read-only proves the protocol will accept an **AddGasKey
action** at version 86 — the RPC handler can exist in the binary while the
action is version-gated. The configs are identical in shape on both chains, so
they cannot discriminate either way.

**Only sending the action settles it.** That is the single unverified assumption
behind preferring gas keys over agent sub-accounts.

## Risk, stated plainly

- Target is **`test015.near`** (the owner), **not** `float.test015.near`. The
  live vault and its real USDC are not touched.
- The key is **function-call restricted** to `float.test015.near` +
  `get_config`, a read-only view method. It cannot move tokens, cannot transfer
  NEAR, cannot add keys, cannot deploy. A function-call key also cannot carry a
  deposit.
- Exposure is the **0.05 NEAR** parked in the gas key, and only if step 6
  (withdraw) fails. Withdraw was verified on testnet: account free went
  `0.017299 -> 0.082762`.
- Total gas across the five writes is roughly 0.001 NEAR.

Before-state, read 2026-10-31:

```
test015.near   balance 0.180747   storage 182 bytes (locked 0.001820)   FREE 0.178927
  keys: 1   FullAccess ed25519:DHyH8bhSiKXvQkPMgJ3wRWChXY66mQH1wCWbKuvsaeUR
```

The throwaway keypair for this test:

```
public  ed25519:DiJqNoUA4UQcxyTNcb5xGqkKJd25QzePq9xkpCEpXWME
secret  .demo/gaskey-mainnet-probe.json   (gitignored; needed only for step 4)
```

## The commands

Every argument form below was checked against `near-cli-rs 0.30.1 --help`
before being written down. That check exists because
`measure-global-contract.sh` shipped with `sign-as` where the CLI wanted the
account as a positional argument, and it would have failed at step one.

Run in **git-bash**, not WSL — `sign-with-legacy-keychain` reads `$HOME`, which
differs under WSL and will find no credentials.

```bash
GK=ed25519:DiJqNoUA4UQcxyTNcb5xGqkKJd25QzePq9xkpCEpXWME
```

### 1 — add the gas key  ← THE DECISIVE STEP

```bash
near account add-key test015.near grant-gas-key-function-call-access \
  --num-nonces 1 \
  --contract-account-id float.test015.near \
  --function-names get_config \
  use-manually-provided-public-key "$GK" \
  network-config mainnet sign-with-legacy-keychain send
```

**If this succeeds, gas keys are live on mainnet and the architecture question
is answered.** If it fails with an unsupported-action or
deserialization error, they are not, and the agent sub-account stays the only
option until a later protocol version.

### 2 — read it back (read-only, free)

```bash
near account view-gas-key-nonces test015.near "$GK" network-config mainnet now
```

Expect `balance: "0"` — gas keys are created empty. On testnet the permission
read back as:

```json
{"GasKeyFunctionCall":{"allowance":null,"balance":"0",
  "method_names":["get_config"],"num_nonces":1,
  "receiver_id":"float.test015.near"}}
```

Note `allowance: null` — for a gas key **the balance is the cap**.

### 3 — fund its own balance

```bash
near account fund-gas-key test015.near "$GK" '0.05 NEAR' \
  network-config mainnet sign-with-legacy-keychain send
```

`test015.near`'s free balance should drop by ~0.05 and the gas key's own
balance should become 0.05.

### 4 — a call paid BY THE GAS KEY  ← the second decisive step

Signed with the gas key's own private key, from
`.demo/gaskey-mainnet-probe.json`. 30 TGas, because the reservation is
`prepaid × 1e9` and 30 TGas → ~0.030919, which 0.05 covers.

```bash
near contract call-function as-transaction float.test015.near get_config \
  json-args '{}' prepaid-gas '30.0 Tgas' attached-deposit '0 NEAR' \
  sign-as test015.near \
  network-config mainnet \
  sign-with-plaintext-private-key '<private_key from .demo/gaskey-mainnet-probe.json>' send
```

Then re-read step 2. **The gas key's balance should fall and
`test015.near`'s free balance should NOT.** That is the whole point: the key
pays from its own pot, which is why agents do not contend.

### 5 — withdraw the float back

```bash
near account withdraw-from-gas-key test015.near "$GK" '0.045 NEAR' \
  network-config mainnet sign-with-legacy-keychain send
```

Proves the float is **recoverable** — the property an agent sub-account does not
have, where 10.7752 NEAR is already permanently stranded.

### 6 — remove the key

```bash
near account delete-keys test015.near public-keys "$GK" \
  network-config mainnet sign-with-legacy-keychain send
```

## Verifying afterwards

```bash
node -e "import('near-api-js').then(async m=>{const p=new m.JsonRpcProvider({url:'https://free.rpc.fastnear.com'});const s=await p.viewAccount({accountId:'test015.near',blockQuery:{finality:'final'}});const k=await p.viewAccessKeyList({accountId:'test015.near',blockQuery:{finality:'final'}});console.log('balance',(Number(s.amount)/1e24).toFixed(6),'keys',k.keys.length)})"
```

Expect: one key (the original full-access), balance back near 0.1795 less ~0.006
of gas and the ~0.005 consumed by the step-4 call.

## What each outcome means

| outcome | conclusion |
| --- | --- |
| step 1 succeeds | gas keys are live on mainnet; adopt them, skip the sub-account recovery fix |
| step 1 fails | not live at 86 despite the docs; keep agent sub-accounts and **do** the 6-line recovery fix, because it is forward-only |
| step 4 drains the GAS KEY only | no contention — one vault can host many agents cheaply |
| step 4 drains the ACCOUNT | the testnet result does not transfer; re-measure the contention ceiling on mainnet |
| step 5 succeeds | the float is recoverable, unlike a sub-account's 0.55 |
