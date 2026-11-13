/**
 * The keyring must not move when the directory does.
 *
 * Every test here injects `cwd` and `home` rather than using the real ones,
 * because a test that reads `process.cwd()` passes or fails depending on where
 * the runner was started — which is the exact class of bug under test.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { countFor, KEYRING_FILENAME, resolveKeyringPath } from "./keyring-path.js";

const VAULT = "test015-near.usefloat.near";

/** A keyring on disk under a fresh temp root. Returns the ROOT, not the file. */
function ringRoot(entries: unknown[]): string {
  const root = mkdtempSync(join(tmpdir(), "float-ring-"));
  mkdirSync(join(root, ".float"), { recursive: true });
  writeFileSync(join(root, KEYRING_FILENAME), JSON.stringify(entries), "utf8");
  return root;
}

const entry = (vault: string, role: string) => ({
  agentId: vault,
  role,
  secret: "ed25519:placeholder-not-a-real-key",
});

describe("resolveKeyringPath", () => {
  it("returns an absolute path even when the override is relative", () => {
    const got = resolveKeyringPath({
      explicit: ".float/agent-keys.json",
      cwd: resolve("/tmp/somewhere"),
      home: resolve("/home/u"),
      count: () => 0,
    });
    expect(got.path).toBe(resolve("/tmp/somewhere", ".float/agent-keys.json"));
    expect(got.why).toMatch(/NEAR_VAULT_AGENT_KEYS/);
  });

  it("an explicit absolute override is used verbatim", () => {
    const pinned = resolve("/opt/keys/ring.json");
    expect(
      resolveKeyringPath({ explicit: pinned, cwd: resolve("/a"), home: resolve("/h") }).path,
    ).toBe(pinned);
  });

  /**
   * THE REGRESSION. With no override and no existing keys, two different
   * launch directories must land on the SAME file. Before this module they
   * landed on two, which is how a `travel` key written from one project was
   * invisible from another.
   */
  it("with no override, the path does NOT depend on the launch directory", () => {
    const home = resolve("/home/u");
    const a = resolveKeyringPath({ cwd: resolve("/projects/one"), home, vault: VAULT, count: () => 0 });
    const b = resolveKeyringPath({ cwd: resolve("/projects/two"), home, vault: VAULT, count: () => 0 });
    expect(a.path).toBe(b.path);
    expect(a.path).toBe(join(home, KEYRING_FILENAME));
  });

  /**
   * BACK-COMPAT, and the reason this change cannot strand anyone: a user whose
   * keys are already in a project-local `.float/` keeps using that file.
   */
  it("prefers a project-local keyring that already holds a key for this vault", () => {
    const cwd = ringRoot([entry(VAULT, "agent")]);
    const home = mkdtempSync(join(tmpdir(), "float-home-"));
    const got = resolveKeyringPath({ cwd, home, vault: VAULT });
    expect(got.path).toBe(resolve(cwd, KEYRING_FILENAME));
    expect(got.why).toMatch(/already holds a key/);
  });

  /** A keyring holding only ANOTHER vault's keys must not capture resolution. */
  it("ignores a project-local keyring that holds no key for this vault", () => {
    const cwd = ringRoot([entry("someone-else.near", "agent")]);
    const home = mkdtempSync(join(tmpdir(), "float-home-"));
    const got = resolveKeyringPath({ cwd, home, vault: VAULT });
    expect(got.path).toBe(join(home, KEYRING_FILENAME));
  });

  /**
   * A SPLIT KEYRING IS REPORTED, NOT SILENTLY RESOLVED. Choosing one and
   * saying nothing is how "my agent vanished" becomes unanswerable.
   */
  it("reports the other keyring when both hold keys for this vault", () => {
    const cwd = ringRoot([entry(VAULT, "agent")]);
    const homeRoot = ringRoot([entry(VAULT, "research")]);
    const got = resolveKeyringPath({ cwd, home: homeRoot, vault: VAULT });
    expect(got.path).toBe(join(homeRoot, KEYRING_FILENAME));
    expect(got.alsoFound).toEqual([resolve(cwd, KEYRING_FILENAME)]);
  });

  it("reports nothing extra in the ordinary single-keyring case", () => {
    const home = mkdtempSync(join(tmpdir(), "float-home-"));
    expect(resolveKeyringPath({ cwd: resolve("/x"), home, vault: VAULT }).alsoFound).toEqual([]);
  });
});

describe("countFor", () => {
  it("counts only this vault's entries", () => {
    const root = ringRoot([entry(VAULT, "a"), entry(VAULT, "b"), entry("other.near", "c")]);
    expect(countFor(join(root, KEYRING_FILENAME), VAULT)).toBe(2);
  });

  /**
   * Resolution must FIND a keyring written in a shape `roles.ts` will not
   * load, or it sends the user to an empty home ring while their real keys sit
   * in a file it refused to count. Finding and loading are separate jobs.
   */
  it("counts an entry whose credential field is privateKey, not secret", () => {
    const root = ringRoot([{ agentId: VAULT, role: "a", privateKey: "ed25519:x" }]);
    expect(countFor(join(root, KEYRING_FILENAME), VAULT)).toBe(1);
  });

  it("an entry with no credential at all does not count", () => {
    const root = ringRoot([{ agentId: VAULT, role: "a" }]);
    expect(countFor(join(root, KEYRING_FILENAME), VAULT)).toBe(0);
  });

  it("a missing or corrupt file counts zero rather than throwing", () => {
    expect(countFor(join(tmpdir(), "float-does-not-exist-xyz.json"), VAULT)).toBe(0);
    const root = mkdtempSync(join(tmpdir(), "float-bad-"));
    mkdirSync(join(root, ".float"), { recursive: true });
    writeFileSync(join(root, KEYRING_FILENAME), "{not json", "utf8");
    expect(countFor(join(root, KEYRING_FILENAME), VAULT)).toBe(0);
  });
});
