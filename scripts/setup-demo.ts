// Creates the read-only demo: a user with a random password and a "Demo workspace" they own for now (so sample data can be loaded).
// Writes email, password and ids to the file named by OUT. Nothing is printed.
//   OUT=<file> npm run setup-demo -- create      creates the user and workspace
//   OUT=<file> npm run setup-demo -- lock        makes the demo user a plain member, so it can no longer manage anything
import fs from "node:fs";
import { randomBytes } from "node:crypto";
import { serviceDb } from "../lib/db";

async function main() {
  const mode = process.argv[2]; const out = process.env.OUT ?? "";
  if (!out) throw new Error("set OUT to a file path");
  const sdb = serviceDb();
  if (mode === "create") {
    const email = "demo@outreach-engine.example"; const password = randomBytes(18).toString("base64url");
    const old = await sdb.rpc("find_user_id_by_email", { p_email: email });
    if (old.data) await sdb.auth.admin.deleteUser(old.data as string);
    const u = await sdb.auth.admin.createUser({ email, password, email_confirm: true });
    if (u.error || !u.data.user) throw new Error("could not create the demo user");
    const ws = await sdb.from("workspaces").insert({ name: "Demo workspace", created_by: u.data.user.id }).select("id").single();
    if (ws.error) throw new Error("could not create the demo workspace");
    const id = (ws.data as { id: string }).id;
    await sdb.from("workspace_members").insert({ workspace_id: id, user_id: u.data.user.id, role: "owner" });
    fs.writeFileSync(out, JSON.stringify({ email, password, userId: u.data.user.id, workspaceId: id }), { mode: 0o600 });
  } else if (mode === "lock") {
    const c = JSON.parse(fs.readFileSync(out, "utf8")) as { userId: string; workspaceId: string };
    const r = await sdb.from("workspace_members").update({ role: "member" }).eq("workspace_id", c.workspaceId).eq("user_id", c.userId).select("role");
    if (r.error || !r.data?.length) throw new Error("could not lock the demo user");
  } else throw new Error("use create or lock");
}
main().catch((e) => { console.error("failed:", (e as Error).message); process.exit(1); });
