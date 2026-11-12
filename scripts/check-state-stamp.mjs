#!/usr/bin/env node
/**
 * Does STATE.md's stamp still describe STATE.md's contents?
 *
 * WHAT WENT WRONG, three times in one day. `STATE.md` carries
 * `<!-- STAMP commit=<sha> -->`, and the SessionStart hook compares it to HEAD
 * so a new session knows how far the ledger has drifted from the code. The
 * stamp is maintained by hand, and the failure is silent: PR #32 edited the
 * file's CONTENT and left the stamp alone, #33 carried that forward, and main
 * ended up three commits ahead of what its own ledger claimed to describe.
 * Nothing noticed until a stop-hook complained, twice.
 *
 * THE RULE THIS ENFORCES, and why it is not the obvious one.
 *
 * The obvious rule — "if STATE.md changed, the stamp must change in the same
 * commit" — is wrong here and would fire on every legitimate edit. This repo
 * squash-merges, so a branch's sha is destroyed on merge and a stamp written
 * before merging names a commit that will never exist. The honest sequence is
 * edit -> merge -> stamp, which means content legitimately lands one commit
 * before its stamp.
 *
 * So the invariant is: THE STAMPED COMMIT MUST NOT BE OLDER THAN THE LAST
 * COMMIT THAT CHANGED STATE.md's CONTENT. Equal is fine (stamped in the same
 * commit). Newer is fine (a stamp-only commit, which is the structural floor —
 * a commit cannot name its own sha before it exists). Older means the ledger
 * describes a tree that has since moved, which is exactly the #32 defect.
 *
 * THE STAMP LINE ITSELF IS NOT CONTENT. Counting it would make every
 * stamp-only commit look like a content change and the check could never pass.
 *
 * CHECKED AGAINST THE DEFAULT BRANCH, not HEAD. On a feature branch the
 * content change exists and its stamp cannot yet, by the argument above;
 * failing there would make the gate unpassable during normal work. The ledger
 * is a property of what has LANDED.
 */
import { execSync } from "node:child_process";

const BRANCH = process.env.STATE_STAMP_BRANCH ?? "main";
const FILE = "STATE.md";

const git = (cmd) => execSync(`git ${cmd}`, { encoding: "utf8" }).trim();
const fail = (...lines) => {
  console.error(`BROKEN: ${lines.join("\n  ")}`);
  process.exit(1);
};

let branchRef;
try {
  branchRef = git(`rev-parse --verify --quiet ${BRANCH}`) || git(`rev-parse --verify origin/${BRANCH}`);
} catch {
  fail(`no branch '${BRANCH}' and no origin/${BRANCH}; cannot tell what has landed.`);
}

let fileAtBranch;
try {
  fileAtBranch = execSync(`git show ${branchRef}:${FILE}`, { encoding: "utf8" });
} catch {
  fail(`${FILE} does not exist on ${BRANCH}.`);
}

const STAMP = /<!--\s*STAMP commit=([0-9a-f]+) date=([0-9-]+)\s*-->/;
const m = STAMP.exec(fileAtBranch);
if (!m) {
  fail(
    `${FILE} on ${BRANCH} has no stamp line.`,
    `Expected: <!-- STAMP commit=<short-sha> date=<YYYY-MM-DD> -->`,
  );
}
const [, stampSha] = m;

// The stamped commit must be a real commit. A sha from a squashed branch
// resolves to nothing, and the SessionStart hook then reports drift as
// UNKNOWN rather than a number - which reads as "fine" at a glance.
try {
  // NOT `<sha>^{commit}`: on Windows cmd the caret is the escape character, so
  // git receives `<sha>{commit}` and reports every sha as unknown. Measured here.
  const t = git(`cat-file -t ${stampSha}`);
  if (t !== "commit") throw new Error(t);
} catch {
  fail(
    `${FILE} is stamped ${stampSha}, which is not a commit git knows.`,
    `That usually means it was stamped on a branch before a squash-merge destroyed the sha.`,
    `Stamp AFTER merging, using the sha the merge produced.`,
  );
}

/**
 * REACHABLE FROM THE BRANCH, not merely a commit that exists.
 *
 * `cat-file -t` above succeeds on an ORPHANED commit — one left dangling by an
 * amend or a rebase — because the object survives until gc collects it. And
 * the ancestor test below treats "unrelated" as fine (its own catch says
 * "stamp is newer, or unrelated"). So an orphan passed BOTH checks.
 *
 * Measured 2026-11-12: amending a commit to fix its stamp makes the stamp name
 * the PRE-amend sha, which is unreachable the instant the amend lands. The
 * gate stayed green while STATE.md pointed at a tree that was never on the
 * branch — worse than a stale stamp, because the SessionStart hook will diff
 * against a commit nobody can look at.
 *
 * The lesson for fixing a stamp: use a SEPARATE commit, never an amend. The
 * content-change walk below ignores stamp-only edits, so a follow-up stamp
 * commit is correct and does not chase its own tail.
 */
try {
  execSync(`git merge-base --is-ancestor ${stampSha} ${branchRef}`, { stdio: "ignore" });
} catch {
  fail(
    `${FILE} is stamped ${stampSha}, which is NOT REACHABLE from ${BRANCH}.`,
    ``,
    `The commit exists in the object store but is not on the branch — the usual`,
    `cause is amending or rebasing the commit the stamp named. The ledger now`,
    `points at a tree that was never on ${BRANCH}.`,
    ``,
    `Fix: re-stamp in a SEPARATE commit (never an amend) to the sha holding the`,
    `content:`,
    `  <!-- STAMP commit=${git(`rev-parse --short ${branchRef}`)} date=<today> -->`,
  );
}

/**
 * The last commit that changed anything in STATE.md EXCEPT the stamp line.
 *
 * Walks the file's history and diffs each revision with the stamp stripped,
 * rather than trusting `git log -- STATE.md`, which cannot tell a content edit
 * from a stamp bump.
 */
const strip = (s) => s.replace(STAMP, "").replace(/^\s*\n/, "");
const revs = git(`rev-list ${branchRef} -- ${FILE}`).split("\n").filter(Boolean);

let lastContentChange = revs[revs.length - 1]; // the commit that introduced it
for (let i = 0; i < revs.length; i++) {
  const rev = revs[i];
  const parent = revs[i + 1];
  if (!parent) break;
  let now, before;
  try {
    now = strip(execSync(`git show ${rev}:${FILE}`, { encoding: "utf8" }));
    before = strip(execSync(`git show ${parent}:${FILE}`, { encoding: "utf8" }));
  } catch {
    continue;
  }
  if (now !== before) {
    lastContentChange = rev;
    break;
  }
}

const shortOf = (sha) => git(`rev-parse --short ${sha}`);
const stampFull = git(`rev-parse ${stampSha}`);
const contentFull = git(`rev-parse ${lastContentChange}`);

// `merge-base --is-ancestor A B` exits 0 when A is an ancestor of B. The stamp
// is STALE exactly when it is a strict ancestor of the last content change.
let stampIsOlder = false;
if (stampFull !== contentFull) {
  try {
    execSync(`git merge-base --is-ancestor ${stampFull} ${contentFull}`, { stdio: "ignore" });
    stampIsOlder = true;
  } catch {
    stampIsOlder = false; // stamp is newer, or unrelated
  }
}

if (stampIsOlder) {
  const behind = git(`rev-list --count ${stampFull}..${contentFull}`);
  fail(
    `${FILE} on ${BRANCH} is stamped ${stampSha}, but its CONTENT last changed in ` +
      `${shortOf(contentFull)}, which is ${behind} commit(s) newer.`,
    ``,
    `The ledger describes a tree that has since moved. That is the #32 defect:`,
    `content edited, stamp left alone, and nothing noticed for three commits.`,
    ``,
    `Fix: re-stamp to the sha that is now ${BRANCH}'s HEAD.`,
    `  <!-- STAMP commit=${git(`rev-parse --short ${branchRef}`)} date=<today> -->`,
  );
}

const drift = git(`rev-list --count ${stampFull}..${branchRef}`);
console.log(
  `state stamp: ${stampSha} is not older than the last content change ` +
    `(${shortOf(contentFull)}); ${BRANCH} is ${drift} commit(s) ahead`,
);
