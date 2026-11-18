import { execFileSync } from "node:child_process";
import { z } from "zod";
import { createLLM, modelFor } from "../lib/llm";
import { hunterAccount } from "../lib/poc";
import { checkGoogleAuth, sendTestEmail } from "../lib/send";

let failures = 0;
const line = (ok: boolean, name: string, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  " + detail : ""}`);
};

async function step(name: string, fn: () => Promise<string | void>) {
  try {
    line(true, name, (await fn()) || "");
  } catch (e) {
    line(false, name, (e as Error).message);
  }
}

function cli(cmd: string, args: string[]): string {
  return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

async function main() {
  const provider = process.env.LLM_PROVIDER || "gemini";
  const required = ["SEND_TO", "SENDER_NAME", "APP_PASSWORD", "HUNTER_API_KEY", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REFRESH_TOKEN", provider === "anthropic" ? "ANTHROPIC_API_KEY" : "GEMINI_API_KEY"];
  for (const name of required) line(Boolean(process.env[name]), `env ${name}`, process.env[name] ? "set" : "MISSING");
  if (required.some((n) => !process.env[n])) {
    console.log("\nStopping: fill in the missing values in .env.local, then run `npm run preflight` again.");
    process.exit(1);
  }

  await step(`LLM (${provider}) models exist`, async () => {
    if (provider !== "gemini") return "skipped for this provider";
    const res = await fetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000", { headers: { "x-goog-api-key": process.env.GEMINI_API_KEY ?? "" } });
    if (!res.ok) throw new Error(`models list returned ${res.status}`);
    const names = ((await res.json()) as { models: { name: string }[] }).models.map((m) => m.name.replace(/^models\//, ""));
    for (const tier of ["cheap", "strong"] as const) {
      const m = modelFor(tier);
      if (!names.includes(m)) throw new Error(`model "${m}" not available. Set LLM_MODEL_${tier.toUpperCase()} to one of: ${names.filter((n) => /flash|pro/.test(n)).slice(0, 8).join(", ")}`);
    }
    return `cheap=${modelFor("cheap")} strong=${modelFor("strong")}`;
  });
  await step("LLM answers a one-word prompt", async () => {
    const out = await createLLM().json({ tier: "cheap", system: "Answer in JSON.", prompt: 'Return {"word":"ok"}', schema: z.object({ word: z.string() }) });
    return `reply=${out.word}`;
  });
  await step("Hunter account reachable", async () => {
    const a = await hunterAccount();
    return `searches used=${a.used} available=${a.available}`;
  });
  await step("Google refresh token exchanges for an access token", async () => {
    await checkGoogleAuth();
  });
  if (!process.argv.includes("--no-send")) {
    await step("Gmail sends one test email to SEND_TO", async () => {
      const r = await sendTestEmail("[TEST] outreach-engine preflight", "If you can read this, Gmail sending works. No prospect was contacted.");
      if (!r.ok) throw new Error(r.message);
      return "check your inbox";
    });
  }
  await step("GitHub CLI logged in", async () => {
    cli("gh", ["auth", "status"]);
  });
  await step("Vercel CLI logged in", async () => `user=${cli("vercel", ["whoami"]).split("\n").pop()}`);

  console.log(failures ? `\n${failures} check(s) failed. Fix them and rerun. No build step may start until all pass.` : "\nAll checks passed.");
  process.exit(failures ? 1 : 0);
}

main();
