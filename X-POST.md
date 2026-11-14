# Demo post for X — pick one, post it yourself

Both include the three required things: **built at NEAR HACKATHON**,
**@NEARProtocol**, **#NEARHackathon**. Attach the video.

`@NearLegion` and `@NearBuilders` are optional and bring more amplification —
added to both drafts; drop them if you'd rather.

---

## Option A — the refusal leads (recommended)

> Give an AI agent a budget today and it's a number in a config file. The agent
> can read it. It can also just… not respect it.
>
> So I built Float at NEAR HACKATHON: the budget lives in a smart contract, and
> the agent gets a key that can call **one method on one contract**.
>
> In the video: the agent pays 0.01 USDC — settles. Then asks for 15 — and the
> contract refuses it, naming *which* limit stopped it and at which level of the
> budget tree. Nothing sent. That refusal is a real mainnet transaction you can
> open yourself.
>
> It can't withdraw. It can't raise its own limit. Not a prompt — a NEAR
> function-call key restriction, enforced before the contract even runs.
>
> Try it: `npx -y @floatonnear/mcp` · usefloat.xyz
> Code: github.com/bshuaibu1/float-near
>
> Curious what the people building agent fleets think: is a per-agent cap
> enough, or do you need the whole fleet sharing one ceiling?
>
> @NEARProtocol @NearBuilders @NearLegion #NEARHackathon

---

## Option B — shorter, for a tighter timeline

> "Here's $50, don't overspend" is not a security model.
>
> Float, built at NEAR HACKATHON: an AI agent's spending limit enforced by a
> smart contract, not by a prompt. The agent's key can call one method on one
> contract — it cannot withdraw, cannot raise its own cap, cannot touch your
> wallet. That's NEAR's function-call key, not a rule the model agreed to follow.
>
> In the video it pays, then gets refused — and the contract says which limit
> stopped it. Live on mainnet.
>
> `npx -y @floatonnear/mcp` · usefloat.xyz
> github.com/bshuaibu1/float-near
>
> Would you give an agent money if the limit was enforced like this?
>
> @NEARProtocol @NearBuilders @NearLegion #NEARHackathon

---

## Why these are shaped this way

The guidance in `HACKATHON.md` asks for four things, and each line above is
doing one of them:

1. **Lead with the user problem**, understandable to someone who has never
   heard of the project — hence "a number in a config file", not "hierarchical
   budget enforcement".
2. **One complete moment**, action to visible result — the pay-then-refuse pair,
   which is the whole demo.
3. **NEAR's role, concretely** — "function-call key restriction, enforced before
   the contract even runs". Not "powered by NEAR".
4. **A next step and a real question** — the install line, and a question you
   actually want answered rather than "thoughts?".

**Do not claim** cross-chain works in the post. It is implemented and
quote-signed but has never run on mainnet, and the README says so. A post that
over-claims is the one thing a screener can check against the repo.
