// Local background worker: processes queued and running runs until they finish, with no browser open.
// It acts as the service role, one workspace at a time, taken from each run.
// Usage: npm run worker            (all active runs)
//        npm run worker -- <runId> (one run)
import { runWithCtx } from "../lib/ctx";
import { serviceCtx, serviceDb } from "../lib/db";
import { tickRun } from "../lib/services/runs";

async function activeRuns(only?: string): Promise<{ id: string; workspace_id: string }[]> {
  let q = serviceDb().from("runs").select("id, workspace_id").in("status", ["queued", "running"]).order("created_at");
  if (only) q = serviceDb().from("runs").select("id, workspace_id").eq("id", only);
  return ((await q).data ?? []) as { id: string; workspace_id: string }[];
}

async function main() {
  const only = process.argv[2];
  for (;;) {
    const runs = await activeRuns(only);
    if (runs.length === 0) { console.log("No active runs. Done."); return; }
    let worked = false;
    for (const r of runs) {
      const t = await runWithCtx(serviceCtx(r.workspace_id), () => tickRun(r.id));
      console.log(`${r.id.slice(0, 8)}  ${t.state}${t.domain ? `  ${t.domain} -> ${t.stage}` : ""}${t.note ? `  ${t.note}` : ""}`);
      if (t.state === "processed") worked = true;
      if (t.state === "finished" && only) return;
      if (t.state === "paused" && only) { console.log("Run is paused. Resume it in the app."); return; }
    }
    if (!worked) await new Promise((r) => setTimeout(r, 3000));
  }
}
main().catch((e) => { console.error("worker failed:", (e as Error).message); process.exit(1); });
