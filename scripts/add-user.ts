// Creates a sign-in account and puts it in a workspace. Run by whoever operates the app; there is no open sign-up.
//   npm run add-user -- someone@example.com                 (asks for a password; joins the workspace named "Default workspace" as owner if it has no owner yet, otherwise as a member)
//   npm run add-user -- someone@example.com --workspace "Client A" --owner
// The password is read with hidden input and never printed or stored anywhere but Supabase Auth.
import readline from "node:readline";
import { serviceDb } from "../lib/db";

function ask(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const w = rl as unknown as { _writeToOutput: (s: string) => void };
    const orig = w._writeToOutput.bind(rl);
    w._writeToOutput = (s: string) => { if (s.includes(prompt)) orig(s); else if (s === "\r\n" || s === "\n") orig(s); };
    rl.question(prompt, (a) => { rl.close(); resolve(a); });
  });
}

async function main() {
  const args = process.argv.slice(2);
  const email = (args[0] ?? "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { console.error("Usage: npm run add-user -- you@example.com [--workspace \"Name\"] [--owner]"); process.exit(1); }
  const wsName = args.includes("--workspace") ? args[args.indexOf("--workspace") + 1] : "Default workspace";
  const wantOwner = args.includes("--owner");
  const sdb = serviceDb();

  const existing = await sdb.rpc("find_user_id_by_email", { p_email: email });
  let userId = existing.data as string | null;
  if (userId) console.log("An account with that email already exists. Adding it to the workspace.");
  else {
    const pw = await ask("Choose a password (at least 12 characters, hidden): ");
    const pw2 = await ask("Type it again: ");
    if (pw !== pw2) { console.error("Passwords did not match."); process.exit(1); }
    if (pw.length < 12) { console.error("Use at least 12 characters."); process.exit(1); }
    const made = await sdb.auth.admin.createUser({ email, password: pw, email_confirm: true });
    if (made.error || !made.data.user) { console.error("Could not create the account:", made.error?.message ?? "unknown"); process.exit(1); }
    userId = made.data.user.id;
    console.log("Account created.");
  }

  let ws = (await sdb.from("workspaces").select("id").eq("name", wsName).order("created_at").limit(1)).data?.[0] as { id: string } | undefined;
  if (!ws) {
    const made = await sdb.from("workspaces").insert({ name: wsName, created_by: userId }).select("id").single();
    if (made.error) { console.error("Could not create the workspace."); process.exit(1); }
    ws = made.data as { id: string };
    console.log(`Workspace "${wsName}" created.`);
  }
  const owners = (await sdb.from("workspace_members").select("user_id").eq("workspace_id", ws.id).eq("role", "owner")).data?.length ?? 0;
  const role = wantOwner || owners === 0 ? "owner" : "member";
  const ins = await sdb.from("workspace_members").upsert({ workspace_id: ws.id, user_id: userId, role }, { onConflict: "workspace_id,user_id" });
  if (ins.error) { console.error("Could not add them to the workspace."); process.exit(1); }
  console.log(`${email} is ${role === "owner" ? "an owner" : "a member"} of "${wsName}". They can sign in now.`);
}
main().catch((e) => { console.error("failed:", (e as Error).message); process.exit(1); });
