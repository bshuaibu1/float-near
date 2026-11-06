/**
 * Add post-sign verification to the policies page.
 *
 * Every prepared transaction gains a declarative `expect`, and the
 * Ready-to-sign panel gains a "Check if it landed" action that re-reads the
 * chain and marks each one applied or not-yet.
 */
import { readFileSync, writeFileSync } from "node:fs";

const p = "apps/dashboard/app/policies/page.tsx";
let s = readFileSync(p, "utf8");

function must(from, to, what) {
  if (!s.includes(from)) throw new Error(`not found: ${what}`);
  s = s.replace(from, to);
}

// --- imports ---------------------------------------------------------------
must(
  '} from "@/lib/cooldown";',
  '} from "@/lib/cooldown";\n' +
    'import { appliedStatus, type Expectation, type PolicySnapshot } from "@/lib/applied";',
  "applied import",
);

// --- PreparedTx carries an expectation -------------------------------------
must(
  `type PreparedTx = {
  plan: OwnerPlan;
  title: string;
  lines: Change[];
};`,
  `type PreparedTx = {
  plan: OwnerPlan;
  title: string;
  lines: Change[];
  /**
   * What the chain should look like once this is signed.
   *
   * Declarative rather than a closure so the comparison stays a pure,
   * tested function - see lib/applied.ts.
   */
  expect: Expectation;
};`,
  "PreparedTx.expect",
);

// --- state for the check ---------------------------------------------------
must(
  "  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);",
  "  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);\n" +
    "  const [checking, setChecking] = useState(false);\n" +
    "  const [checkedAt, setCheckedAt] = useState<number | null>(null);",
  "check state",
);

// --- review() attaches expectations ---------------------------------------
must(
  `        built.push({
          plan: await postPlan(g, extra),
          title: GROUP_TITLE[g],
          lines: changes.filter((c) => c.group === g),
        });`,
  `        const nodeId = nodeIdOf(selected, agents);
        const expectation: Expectation =
          g === "caps"
            ? { kind: "caps", nodeId, daily: dailyCap, perTx: perTxCap }
            : g === "cooldown"
              ? { kind: "cooldown", nodeId, seconds: cooldown }
              : { kind: "recipients", nodeId, list: recipientList };
        built.push({
          plan: await postPlan(g, extra),
          title: GROUP_TITLE[g],
          lines: changes.filter((c) => c.group === g),
          expect: expectation,
        });`,
  "review expectations",
);

must(
  "  }, [selected, groups, changes, recipientList, postPlan]);",
  "  }, [selected, agents, groups, changes, recipientList, dailyCap, perTxCap, cooldown, postPlan]);",
  "review deps",
);

// --- runSwitch takes an expectation ---------------------------------------
must(
  `    async (action: string, extra: Record<string, unknown>, title: string, line: Change) => {`,
  `    async (
      action: string,
      extra: Record<string, unknown>,
      title: string,
      line: Change,
      expectation: Expectation,
    ) => {`,
  "runSwitch signature",
);

must(
  "        setTxs([{ plan: await postPlan(action, extra), title, lines: [line] }]);",
  "        setTxs([{ plan: await postPlan(action, extra), title, lines: [line], expect: expectation }]);",
  "runSwitch body",
);

// --- the checker -----------------------------------------------------------
must(
  "  /** Switching agents would silently discard drafts, so ask first. */",
  `  /**
   * Re-read the chain and see whether what was signed is actually there.
   *
   * Without this the page would keep showing the pre-signing numbers after a
   * successful change, and would look identical after a FAILED one - the
   * owner had no way to tell the two apart short of a manual reload.
   *
   * It reuses load(), so a success also refreshes the displayed values.
   */
  const checkApplied = useCallback(async () => {
    setChecking(true);
    try {
      await load();
      setCheckedAt(Date.now());
    } finally {
      setChecking(false);
    }
  }, [load]);

  /** The agent list in the shape lib/applied.ts compares against. */
  const snapshots = useMemo<PolicySnapshot[]>(
    () =>
      agents.map((a) => ({
        nodeId: nodeIdOf(a, agents),
        dailyBudget: a.policy?.dailyBudget,
        perTxLimit: a.policy?.perTxLimit,
        cooldownSeconds: a.policy?.cooldownSeconds,
        ownAllowedAddresses: a.policy?.ownAllowedAddresses,
        frozen: a.status === "killed",
      })),
    [agents],
  );

  /** Switching agents would silently discard drafts, so ask first. */`,
  "checker",
);

writeFileSync(p, s);
console.log("  wired expectations + checker into the page");
