import { describe, it, expect } from "vitest";
import { parseEnvFile } from "./env-file.js";

/**
 * Why the adapter parses its own env file instead of being handed one by the
 * shell.
 *
 * Every doc in this repo says:
 *
 *   set -a && . .float/adapter.env && set +a && npx @floatonnear/float-adapter
 *
 * That idiom is a known failure on a real box. From this project's memory
 * (prod-env-file-cannot-be-sourced-by-bash): a single unquoted value containing
 * a space made `set -a; . .env; set +a` die with `Scan: command not found`, and
 * every script that opened with that line failed before it ran.
 *
 * The file in question here is WRITTEN BY create-float and holds the agent
 * key, the quote signer and the API token. A deploy path that can be broken by
 * a space — or, worse, that lets a value be interpreted as a command — is the
 * wrong mechanism for carrying secrets onto a VPS.
 *
 * So: no shell, no `set -a`, one parser with tests.
 */

describe("parseEnvFile", () => {
  it("reads the shape create-float actually writes", () => {
    const env = parseEnvFile(
      [
        "# Written by create-float. The adapter serves the dashboard's /v1 API.",
        "NEAR_VAULT_CONTRACT=float.test015.near",
        "NEAR_VAULT_TOKEN_DECIMALS=6",
        "PORT=8787",
        "",
        "# Required for POST /v1/pay, which signs with the agent key below.",
        "FLOAT_API_TOKEN=aBc-123_XyZ",
      ].join("\n"),
    );
    expect(env.NEAR_VAULT_CONTRACT).toBe("float.test015.near");
    expect(env.PORT).toBe("8787");
    expect(env.FLOAT_API_TOKEN).toBe("aBc-123_XyZ");
  });

  it("does NOT execute anything — a value is data, never a command", () => {
    // The whole reason this exists. Under `set -a; . file` these lines run.
    const env = parseEnvFile(
      ["MSG=Float is temporarily down", "EVIL=$(touch /tmp/pwned)", "TICK=`id`"].join("\n"),
    );
    expect(env.MSG).toBe("Float is temporarily down");
    expect(env.EVIL).toBe("$(touch /tmp/pwned)");
    expect(env.TICK).toBe("`id`");
  });

  it("keeps an unquoted value containing spaces, which is what broke the shell", () => {
    expect(parseEnvFile("X_MAINTENANCE_MESSAGE=Pyth Scan is under maintenance").X_MAINTENANCE_MESSAGE).toBe(
      "Pyth Scan is under maintenance",
    );
  });

  it("strips surrounding quotes but preserves inner ones", () => {
    const env = parseEnvFile(['A="quoted value"', "B='single'", 'C=say "hi"'].join("\n"));
    expect(env.A).toBe("quoted value");
    expect(env.B).toBe("single");
    expect(env.C).toBe('say "hi"');
  });

  it("ignores comments, blanks, and a BOM", () => {
    // Same BOM problem as the MCP configs: PowerShell writes one by default,
    // and this file may well have been edited from PowerShell.
    const env = parseEnvFile("﻿# comment\n\n  \nA=1\n# B=2\n");
    expect(env.A).toBe("1");
    expect(env.B).toBeUndefined();
  });

  it("keeps '=' inside a value — base64 padding depends on it", () => {
    // FLOAT_API_TOKEN is base64url and a key can end in '='. Splitting on every
    // '=' would silently truncate a secret, which fails as a 401 nobody can
    // explain.
    expect(parseEnvFile("T=abc==").T).toBe("abc==");
    expect(parseEnvFile("K=ed25519:AbC=/x=").K).toBe("ed25519:AbC=/x=");
  });

  it("tolerates CRLF, because the file may have been written on Windows", () => {
    const env = parseEnvFile("A=1\r\nB=2\r\n");
    expect(env.A).toBe("1");
    expect(env.B).toBe("2");
  });

  it("ignores a line with no '=' rather than inventing an empty key", () => {
    const env = parseEnvFile("JUST_A_WORD\nA=1\n");
    expect(env.A).toBe("1");
    expect(Object.keys(env)).toEqual(["A"]);
  });

  it("trims whitespace around the key and an `export` prefix", () => {
    const env = parseEnvFile("  A = 1\nexport B=2\n");
    expect(env.A).toBe("1");
    expect(env.B).toBe("2");
  });
});

// ---- precedence
//
// A real environment variable must outrank the file, so one service can be
// pointed at a different port or contract without editing a shared secrets
// file. Same precedence the pythscan verify sandbox relied on to aim a run at a
// database COPY while every credential still came from production.

import { applyEnvFile } from "./env-file.js";

describe("applyEnvFile", () => {
  it("fills in what is missing", () => {
    const env: Record<string, string | undefined> = {};
    const applied = applyEnvFile({ A: "1", B: "2" }, env);
    expect(env.A).toBe("1");
    expect(applied.sort()).toEqual(["A", "B"]);
  });

  it("never overrides a variable that is already set", () => {
    const env: Record<string, string | undefined> = { PORT: "9999" };
    const applied = applyEnvFile({ PORT: "8787", HOST: "127.0.0.1" }, env);
    expect(env.PORT).toBe("9999");
    expect(applied).toEqual(["HOST"]);
  });

  it("returns the names applied, never the values", () => {
    // This list is logged at startup. Returning values would print the agent
    // key into pm2's log on every restart.
    const applied = applyEnvFile({ NEAR_VAULT_AGENT_KEY: "ed25519:secret" }, {});
    expect(applied).toEqual(["NEAR_VAULT_AGENT_KEY"]);
    expect(JSON.stringify(applied)).not.toContain("secret");
  });
});
