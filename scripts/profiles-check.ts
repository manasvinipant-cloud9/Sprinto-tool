// Phase 1 check against the real database: seed, edit (new version), clone, resolve by version. Removes what it creates.
import { serviceDb as db } from "../lib/db";
import { enterCtx } from "../lib/ctx";
import { serviceCtx } from "../lib/db";
import { workspaceByName } from "./_service";
import { listProfiles, resolveProfile, saveProfileVersion } from "../lib/services/profiles";
import { loadProfile } from "../lib/profiles";

const ok = (c: boolean, m: string) => { console.log(`${c ? "PASS" : "FAIL"}  ${m}`); if (!c) process.exitCode = 1; };

async function main() {
  const ws = await workspaceByName();
  enterCtx(serviceCtx(ws, "script"));
  const first = await listProfiles();
  ok(first.length >= 2 && first.every((p) => !p.readonly), `seeded and listed ${first.length} profiles`);
  const base = first.find((p) => p.id === "sprinto")!;
  const edited = structuredClone(base.detail);
  edited.limits.max_accounts_per_run = 7;
  const v2 = await saveProfileVersion(edited);
  ok(v2.version === base.version + 1 && v2.detail.limits.max_accounts_per_run === 7, `edit saved as version ${v2.version}`);
  const old = await resolveProfile("sprinto", base.dbId!);
  const latest = await resolveProfile("sprinto");
  ok(old.limits.max_accounts_per_run === 25 && latest.limits.max_accounts_per_run === 7, "old version still resolves exactly; slug resolves to latest");
  const clone = await saveProfileVersion({ ...base.detail, id: "sprinto-copy-check", version: 1 }, { cloneOfDbId: base.dbId! });
  ok(clone.id === "sprinto-copy-check" && clone.version === 1 && clone.clonedFrom === "sprinto", "clone saved as a new profile that remembers its source");
  const again = (await listProfiles()).find((p) => p.id === "sprinto")!;
  ok(again.versions.length === 2 && again.version === 2, "list shows two versions of the edited profile");
  // cleanup: remove the test version and the clone, restore the seed state
  await db().from("profiles").delete().eq("workspace_id", ws).eq("slug", "sprinto-copy-check");
  await db().from("profiles").delete().eq("workspace_id", ws).eq("slug", "sprinto").eq("version", 2);
  const after = (await listProfiles()).find((p) => p.id === "sprinto")!;
  ok(after.version === 1 && loadProfile("sprinto").id === after.id, "cleaned up");
}
main().catch((e) => { console.error("FAIL ", (e as Error).message); process.exit(1); });
