#!/usr/bin/env node
/**
 * Does any shell heredoc execute its own documentation?
 *
 * An UNQUOTED heredoc delimiter (`<<UNIT`, not `<<'UNIT'`) tells bash to run
 * parameter expansion, command substitution and arithmetic on the body. The
 * deploy script needs that — its systemd units interpolate `$ROOT`, `$PORT`,
 * `$DASH_SERVICE`. The cost is that it cannot be selective: backticks in a
 * COMMENT are command substitution too.
 *
 * Measured on wattson 2026-11-10. Three markdown-quoted comments inside the
 * dashboard unit and the nginx vhost were executed at deploy time:
 *
 *     `-H 127.0.0.1`   -> "-H: command not found"
 *     `next start`     -> "next: command not found"
 *     `factory`        -> "factory: command not found"
 *     `ss -ltnp`       -> SUCCEEDED
 *
 * The first three failed loudly and harmlessly. The fourth is the problem:
 * `ss -ltnp` is a real command, so bash ran it and substituted its OUTPUT —
 * a full socket listing with ports and PIDs — into the live
 * `/etc/systemd/system/float-near-dash.service`. `ExecStart` was unaffected,
 * the service started, all 14 post-deploy assertions passed, and nothing
 * anywhere reported a problem. The only symptom was three "command not found"
 * lines in a log, next to a successful deploy.
 *
 * That is the shape worth guarding: a comment is not inert inside an unquoted
 * heredoc, and the damage lands in a file nobody re-reads. Whatever a future
 * comment happens to quote, it will be run on the box as the deploying user.
 *
 * THE RULE: inside an unquoted heredoc, use 'single quotes' in prose, never
 * backticks. Backticks in a QUOTED heredoc (`<<'EOF'`) are fine and ignored.
 */
import { readFileSync } from "node:fs";
import { globSync } from "node:fs";

const files = globSync("scripts/*.sh");
let bad = 0;

for (const path of files) {
  const lines = readFileSync(path, "utf8").split("\n");
  /** @type {{word:string,quoted:boolean}|null} */
  let open = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (open === null) {
      // `<<WORD`, `<<-WORD`, `<<"WORD"`, `<<'WORD'`. Quoted => inert body.
      const m = /<<-?\s*(["']?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(line);
      if (m) open = { word: m[2], quoted: m[1] !== "" };
      continue;
    }

    // A heredoc ends on a line that is EXACTLY the delimiter (ignoring the
    // leading tabs `<<-` strips). Checking `includes` would end the body early
    // on any line that merely mentions the word.
    if (line.trim() === open.word) {
      open = null;
      continue;
    }

    if (open.quoted) continue;

    // Backticks anywhere in an expanding body, and `$(` in a comment.
    //
    // `$(` OUTSIDE a comment is deliberate and common — `$(command -v node)`
    // is how ExecStart finds its interpreter. Backticks are never the right
    // way to write that in this repo, so they are flagged unconditionally.
    const isComment = /^\s*#/.test(line);
    const hasTick = line.includes("`");
    const hasSub = isComment && line.includes("$(");
    if (hasTick || hasSub) {
      if (bad === 0) {
        console.error(
          `BROKEN: shell will EXECUTE these, because the heredoc delimiter is unquoted.\n`,
        );
      }
      console.error(`  ${path}:${i + 1}  (inside <<${open.word})`);
      console.error(`    ${line.trim().slice(0, 100)}`);
      bad++;
    }
  }
}

if (bad) {
  console.error(
    `\n  ${bad} line(s). Inside an unquoted heredoc a comment is not inert: its\n` +
      `  backticks run as commands on the deploy target, and their output is\n` +
      `  written into the file being generated. A real one ('ss -ltnp') already\n` +
      `  dumped a socket listing into a live systemd unit while every assertion\n` +
      `  stayed green.\n\n` +
      `  Fix: use 'single quotes' in prose. If the body needs no variables at\n` +
      `  all, quote the delimiter instead — <<'UNIT'.`,
  );
  process.exit(1);
}
console.log(`heredocs: no self-executing content in ${files.length} shell script(s)`);
