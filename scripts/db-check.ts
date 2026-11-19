// Phase 0 check: a demo run (fake model, fixture pages) is saved to and read back from Supabase, then removed.
import { loadProfile } from "../lib/profiles";
import { runDomain } from "../lib/pipeline";
import { createWorkspace, deleteWorkspace, loadRun, saveProfile, saveRunWithResults } from "../lib/services/runs";
import { makeDeps, QUALIFYING } from "../tests/fakes";

async function main() {
  const profile = loadProfile(process.env.CHECK_PROFILE || "sprinto");
  const result = await runDomain("acme.test", profile, makeDeps(QUALIFYING));
  console.log(`demo run status: ${result.status}`);
  const ws = await createWorkspace("db-check (temporary)");
  try {
    const pid = await saveProfile(ws, profile);
    const runId = await saveRunWithResults(ws, pid, profile, [result]);
    const rows = await loadRun(runId);
    console.log("read back:", JSON.stringify(rows));
    if (result.status !== "drafted" || rows.length !== 1 || (rows[0] as { drafts: unknown[] }).drafts.length !== 1) throw new Error("round trip mismatch");
    console.log("PASS  demo run saved and read back");
  } finally {
    await deleteWorkspace(ws);
    console.log("cleaned up temporary workspace");
  }
}
main().catch((e) => { console.error("FAIL ", (e as Error).message); process.exit(1); });
