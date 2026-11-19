// Throwaway sign-in for trying the UI. `create` makes a user who owns a temporary workspace (with the example profiles) and writes
// the credentials to the file named by OUT. `delete` removes the user and the workspace. Nothing is printed.
import fs from "node:fs";
import { randomBytes } from "node:crypto";
import { enterCtx } from "../lib/ctx";
import { serviceCtx, serviceDb } from "../lib/db";
import { seedExamples } from "../lib/services/profiles";

async function main() {
  const mode = process.argv[2]; const out = process.env.OUT ?? "";
  if (!out) throw new Error("set OUT to a file path");
  if (mode === "create") {
    const email = `ui-${randomBytes(4).toString("hex")}@example.test`; const password = randomBytes(18).toString("base64url");
    const u = await serviceDb().auth.admin.createUser({ email, password, email_confirm: true });
    const ws = (await serviceDb().from("workspaces").insert({ name: "UI test workspace", created_by: u.data.user!.id }).select("id").single()).data as { id: string };
    await serviceDb().from("workspace_members").insert({ workspace_id: ws.id, user_id: u.data.user!.id, role: "owner" });
    enterCtx(serviceCtx(ws.id, "temp"));
    await seedExamples();
    fs.writeFileSync(out, JSON.stringify({ email, password, userId: u.data.user!.id, workspaceId: ws.id }), { mode: 0o600 });
  } else if (mode === "delete") {
    const c = JSON.parse(fs.readFileSync(out, "utf8")) as { userId: string };
    const spaces = (await serviceDb().from("workspace_members").select("workspace_id").eq("user_id", c.userId)).data ?? [];
    for (const w of spaces as { workspace_id: string }[]) await serviceDb().from("workspaces").delete().eq("id", w.workspace_id);
    await serviceDb().auth.admin.deleteUser(c.userId);
  }
}
main().catch((e) => { console.error("failed:", (e as Error).message); process.exit(1); });
