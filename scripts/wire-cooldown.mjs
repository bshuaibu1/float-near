/**
 * Point the policies page at the tested cooldown module.
 *
 * Deletes the page's own COOLDOWNS/cooldownLabel copies and the derived-state
 * select that made Custom unselectable.
 */
import { readFileSync, writeFileSync } from "node:fs";

const p = "apps/dashboard/app/policies/page.tsx";
let s = readFileSync(p, "utf8");
const before = s.length;

function must(from, to, what) {
  if (!s.includes(from)) throw new Error(`not found: ${what}`);
  s = s.replace(from, to);
}

// 1. import
must(
  'import { treeDepth, treeLabel } from "@/lib/tree-label";',
  'import { treeDepth, treeLabel } from "@/lib/tree-label";\n' +
    "import {\n" +
    "  COOLDOWN_PRESETS,\n" +
    "  CUSTOM,\n" +
    "  applyCooldownSelection,\n" +
    "  cooldownLabel,\n" +
    "  cooldownSelectValue,\n" +
    "  initialCustomMode,\n" +
    "  parseCooldownInput,\n" +
    "  showsCustomInput,\n" +
    '} from "@/lib/cooldown";',
  "import",
);

// 2. delete the local COOLDOWNS + cooldownLabel block
const a = s.indexOf("/**\n * Cooldown presets.");
const b = s.indexOf("function splitList(text: string): string[] {");
if (a < 0 || b < 0) throw new Error("local cooldown block markers not found");
s = s.slice(0, a) + s.slice(b);

// 3. customMode state beside the seconds
must(
  "  const [cooldown, setCooldown] = useState(0);",
  "  const [cooldown, setCooldown] = useState(0);\n" +
    "  // Whether the Custom option is chosen. NOT derivable from the seconds:\n" +
    "  // 60 is both a preset and a plausible typed value, so the number alone\n" +
    "  // cannot say which the user picked.\n" +
    "  const [cooldownCustom, setCooldownCustom] = useState(false);",
  "customMode state",
);

// 4. seed it when loading a node
must(
  "    setCooldown(base.cooldown);",
  "    setCooldown(base.cooldown);\n    setCooldownCustom(initialCustomMode(base.cooldown));",
  "seed customMode",
);

// 5. the select itself
must(
  `                      value={COOLDOWNS.some((c) => c.v === cooldown) ? String(cooldown) : "custom"}
                      onChange={(v) => {
                        if (v !== "custom") setCooldown(Number(v));
                      }}`,
  `                      value={cooldownSelectValue(cooldown, cooldownCustom)}
                      onChange={(v) => {
                        const next = applyCooldownSelection(v, cooldown);
                        setCooldown(next.seconds);
                        setCooldownCustom(next.customMode);
                      }}`,
  "select value/onChange",
);

must(
  "                      {COOLDOWNS.map((c) => (",
  "                      {COOLDOWN_PRESETS.map((c) => (",
  "options map",
);

must(
  "                      <option value=\"custom\">Custom</option>",
  "                      <option value={CUSTOM}>Custom</option>",
  "custom option",
);

must(
  "                    {!COOLDOWNS.some((c) => c.v === cooldown) && (",
  "                    {showsCustomInput(cooldown, cooldownCustom) && (",
  "custom input condition",
);

must(
  "                        onChange={(v) => setCooldown(Math.max(0, Math.floor(Number(v) || 0)))}",
  "                        onChange={(v) => setCooldown(parseCooldownInput(v))}",
  "custom input onChange",
);

writeFileSync(p, s);
console.log(`  wired; ${before - s.length} bytes of duplicated logic removed`);
console.log(`  leftover COOLDOWNS refs: ${s.split("COOLDOWNS").length - 1} (want 0)`);
