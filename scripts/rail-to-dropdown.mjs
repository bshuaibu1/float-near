/**
 * Replace the agent rail with a hierarchy-preserving dropdown.
 *
 * The rail showed the tree but ate 15rem of every viewport permanently. A
 * plain <select> frees that width but flattens the tree - and nesting is the
 * whole subject of this page, since a sub-budget is spent OUT OF its parent.
 *
 * So: a custom listbox. Collapsed it is a one-line control; open it renders
 * the same indented tree, caps and containment bars the rail had.
 *
 * A native <select> cannot do this. Its <option> elements accept only text,
 * so depth would have to be faked with padding characters - which is exactly
 * the U+00A0 trap this codebase has already been bitten by three times - and
 * the per-agent cap and share bar could not be shown at all.
 */
import { readFileSync, writeFileSync } from "node:fs";

const p = "apps/dashboard/app/policies/page.tsx";
let s = readFileSync(p, "utf8");

function must(from, to, what) {
  if (!s.includes(from)) throw new Error(`not found: ${what}`);
  s = s.replace(from, to);
}

// --- 1. the picker, above the card ----------------------------------------
must(
  `            {/* MASTER-DETAIL, not a dropdown. A select hides the fleet behind
                a click, so you cannot compare two agents' limits without
                flipping between them — and on a page about who may spend what,
                the comparison IS the job. */}
            <div className="overflow-hidden rounded-xl border border-line bg-card shadow-[0_1px_2px_rgba(17,17,17,0.04)]">
              <div className="grid md:grid-cols-[15rem_1fr]">`,
  `            {/* A DROPDOWN THAT KEEPS THE TREE.
                The rail showed nesting but spent 15rem of every viewport on
                two agents. This collapses to one line and, when open, renders
                the same indented tree with each agent's cap and its share of
                the master - so the containment is still visible, just not
                permanently in the way. */}
            <div className="mb-3 flex flex-wrap items-center gap-3">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-faint">
                Agent
              </span>
              <AgentPicker
                agents={agents}
                selectedId={selectedId}
                onSelect={selectAgent}
                shareOfMaster={shareOfMaster}
                dirtyCount={changes.length}
              />
            </div>

            <div className="overflow-hidden rounded-xl border border-line bg-card shadow-[0_1px_2px_rgba(17,17,17,0.04)]">
              <div>`,
  "picker + card open",
);

// --- 2. delete the aside ---------------------------------------------------
const a = s.indexOf(`                <aside className="border-b border-line bg-canvas md:border-b-0 md:border-r">`);
const b = s.indexOf("                </aside>\n\n");
if (a < 0 || b < 0) throw new Error("aside markers not found");
s = s.slice(0, a) + s.slice(b + "                </aside>\n\n".length);

// --- 3. the component ------------------------------------------------------
must(
  "/** The marker that a row differs from the chain. */",
  `/**
 * The agent selector: a listbox that renders the budget TREE.
 *
 * Not a native <select>. An <option> holds text only, so depth would have to
 * be faked with padding characters - the invisible-character trap this
 * codebase has been bitten by repeatedly - and neither the per-agent cap nor
 * its share of the master could be shown beside the name.
 *
 * Indentation is real padding derived from treeDepth, so it survives HTML
 * whitespace collapsing.
 */
function AgentPicker({
  agents,
  selectedId,
  onSelect,
  shareOfMaster,
  dirtyCount,
}: {
  agents: ApiAgent[];
  selectedId: string;
  onSelect: (id: string) => void;
  shareOfMaster: (a: ApiAgent) => number | null;
  dirtyCount: number;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const sel = agents.find((x) => x.agentId === selectedId) ?? null;
  const selDepth = sel ? treeDepth(sel.displayName) : 0;

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="flex min-w-[15rem] items-center gap-2 rounded-lg border border-line bg-card py-1.5 pl-3 pr-2.5 text-left shadow-[0_1px_2px_rgba(17,17,17,0.04)] transition-colors hover:border-ink/25 focus:outline-none focus:ring-2 focus:ring-ink/10"
      >
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            {/* Depth is still legible with the list CLOSED: a child shows the
                branch glyph, so you can tell a sub-budget from the master
                without opening anything. */}
            {selDepth > 0 && (
              <span aria-hidden className="shrink-0 font-mono text-[11px] text-faint">
                {BRANCH_GLYPH}
              </span>
            )}
            <span className="truncate text-[13px] font-semibold text-ink">
              {sel ? treeLabel(sel.displayName, sel.agentId) : "-"}
            </span>
            {sel?.status === "killed" && (
              <span
                className="shrink-0 rounded-full px-1.5 text-[9px] font-semibold uppercase tracking-wider"
                style={{ background: "#FDEBEC", color: "#9F2F2D" }}
              >
                Frozen
              </span>
            )}
            {dirtyCount > 0 && (
              <span
                title={\`\${dirtyCount} unsaved\`}
                className="h-1.5 w-1.5 shrink-0 rounded-full"
                style={{ background: "#B45309" }}
              />
            )}
          </span>
          <span className="mt-0.5 block truncate text-[10.5px] text-faint">
            {selDepth === 0 ? "master budget" : "sub-budget"}
            {sel?.policy?.dailyBudget ? \` - \${sel.policy.dailyBudget} / day\` : ""}
          </span>
        </span>
        <ChevronDown size={14} aria-hidden className="shrink-0 text-muted" />
      </button>

      {open && (
        <div
          role="listbox"
          className="absolute left-0 top-[calc(100%+6px)] z-30 w-[21rem] overflow-hidden rounded-lg border border-line bg-card"
          style={{ boxShadow: "0 18px 44px rgba(17, 17, 17, 0.12)" }}
        >
          {agents.map((a) => {
            const isSel = a.agentId === selectedId;
            const d = treeDepth(a.displayName);
            const pct = shareOfMaster(a);
            return (
              <button
                key={a.agentId}
                type="button"
                role="option"
                aria-selected={isSel}
                onClick={() => {
                  onSelect(a.agentId);
                  setOpen(false);
                }}
                className={\`block w-full border-b border-line py-2 pr-3 text-left last:border-b-0 transition-colors \${
                  isSel ? "bg-chip" : "hover:bg-chip/60"
                }\`}
                style={{ paddingLeft: \`\${0.75 + d * 0.9}rem\` }}
              >
                <span className="flex items-center gap-1.5">
                  {d > 0 && (
                    <span aria-hidden className="shrink-0 font-mono text-[11px] text-faint">
                      {BRANCH_GLYPH}
                    </span>
                  )}
                  <span
                    className={\`truncate text-[13px] \${isSel ? "font-semibold text-ink" : "font-medium text-ink"}\`}
                  >
                    {treeLabel(a.displayName, a.agentId)}
                  </span>
                  {a.status === "killed" && (
                    <span
                      className="shrink-0 rounded-full px-1.5 text-[9px] font-semibold uppercase tracking-wider"
                      style={{ background: "#FDEBEC", color: "#9F2F2D" }}
                    >
                      Frozen
                    </span>
                  )}
                  <span className="ml-auto flex shrink-0 items-baseline gap-1">
                    <span className="text-[13px] font-semibold tabular-nums tracking-[-0.02em] text-ink">
                      {a.policy?.dailyBudget ?? "-"}
                    </span>
                    <span className="text-[10px] text-faint">/ day</span>
                  </span>
                  {isSel && <Check size={12} className="shrink-0 text-muted" />}
                </span>

                {/* CONTAINMENT, not two bare numbers. "100" and "25" side by
                    side say nothing about the 25 being spent OUT OF the 100 -
                    on a page whose whole subject is nested budgets. */}
                {pct !== null && (
                  <span
                    aria-hidden
                    className="mt-1.5 block h-[3px] w-full overflow-hidden rounded-full bg-chip"
                  >
                    <span
                      className="block h-full rounded-full"
                      style={{ width: \`\${pct}%\`, background: isSel ? "#111111" : "#C9C7C3" }}
                    />
                  </span>
                )}
              </button>
            );
          })}
          <p className="bg-canvas px-3 py-2 text-[10px] leading-4 text-faint">
            bar = share of the master budget
          </p>
        </div>
      )}
    </div>
  );
}

/** The marker that a row differs from the chain. */`,
  "AgentPicker component",
);

writeFileSync(p, s);
console.log("  rail replaced with a tree-preserving dropdown");
