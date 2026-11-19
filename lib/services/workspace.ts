import { audit } from "../audit";
import { currentCtx } from "../ctx";
import { must, serviceDb } from "../db";
import { forgetMemberships } from "../guard";
import type { LlmKeys } from "../llm";
import { decryptSecret, encryptSecret, keyHint, secretsAvailable } from "../secrets";

export class WorkspaceError extends Error { constructor(message: string, public status = 400) { super(message); } }

function requireOwner() {
  if (currentCtx().role !== "owner") throw new WorkspaceError("Only a workspace owner can do that.", 403);
}

// ---------- workspaces ----------

/** Starts a new workspace (a client). Only an existing owner can; the database enforces it too. */
export async function createWorkspaceForUser(name: string): Promise<{ id: string; name: string }> {
  const c = currentCtx();
  const clean = name.trim();
  if (!clean || clean.length > 80) throw new WorkspaceError("A workspace name must be 1 to 80 characters.");
  const res = await c.db.rpc("create_workspace", { p_name: clean });
  if (res.error || !res.data) throw new WorkspaceError(/owner/.test(res.error?.message ?? "") ? "Only a workspace owner can create a workspace." : "Could not create the workspace.", 403);
  if (c.userId) forgetMemberships(c.userId);
  const id = res.data as string;
  await c.db.from("audit_log").insert({ workspace_id: id, user_id: c.userId, actor: c.email, action: "workspace.created", entity_type: "workspace", entity_id: id, detail: { name: clean } });
  return { id, name: clean };
}

export async function renameWorkspace(name: string): Promise<void> {
  requireOwner();
  const c = currentCtx(); const clean = name.trim();
  if (!clean || clean.length > 80) throw new WorkspaceError("A workspace name must be 1 to 80 characters.");
  must(await c.db.from("workspaces").update({ name: clean }).eq("id", c.workspaceId).select("id"), "rename workspace");
  if (c.userId) forgetMemberships(c.userId);
  await audit("workspace.renamed", { type: "workspace", id: c.workspaceId }, { name: clean });
}

// ---------- members ----------

export interface Member { userId: string; email: string; role: "owner" | "member"; since: string }

export async function listMembers(): Promise<Member[]> {
  const c = currentCtx();
  const rows = must<{ user_id: string; role: "owner" | "member"; created_at: string }[]>(await c.db.from("workspace_members").select("user_id, role, created_at").eq("workspace_id", c.workspaceId).order("created_at"), "list members");
  // Emails live in the auth schema; look up only the people in this workspace.
  return Promise.all(rows.map(async (r) => {
    const u = await serviceDb().auth.admin.getUserById(r.user_id);
    return { userId: r.user_id, email: u.data.user?.email ?? "(unknown)", role: r.role, since: r.created_at };
  }));
}

export async function addMember(emailRaw: string): Promise<Member> {
  requireOwner();
  const c = currentCtx();
  const email = emailRaw.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 200) throw new WorkspaceError("Enter a valid email address.");
  const found = await serviceDb().rpc("find_user_id_by_email", { p_email: email });
  if (found.error || !found.data) throw new WorkspaceError("There is no account with that email yet. Ask whoever runs this app to create one (npm run add-user), then add them here.", 404);
  const userId = found.data as string;
  const ins = await c.db.from("workspace_members").insert({ workspace_id: c.workspaceId, user_id: userId, role: "member" }).select("created_at").single();
  if (ins.error) throw new WorkspaceError(/duplicate|unique/i.test(ins.error.message) ? "They are already a member." : "Could not add that person.", 409);
  forgetMemberships(userId);
  await audit("member.added", { type: "member", id: userId }, { email, role: "member" });
  return { userId, email, role: "member", since: (ins.data as { created_at: string }).created_at };
}

export async function removeMember(userId: string): Promise<void> {
  requireOwner();
  const c = currentCtx();
  const rows = must<{ user_id: string; role: string }[]>(await c.db.from("workspace_members").select("user_id, role").eq("workspace_id", c.workspaceId), "list members");
  const target = rows.find((r) => r.user_id === userId);
  if (!target) throw new WorkspaceError("They are not a member of this workspace.", 404);
  if (target.role === "owner" && rows.filter((r) => r.role === "owner").length <= 1) throw new WorkspaceError("A workspace must keep at least one owner.", 409);
  const del = await c.db.from("workspace_members").delete().eq("workspace_id", c.workspaceId).eq("user_id", userId).select("user_id");
  if (del.error || !del.data?.length) throw new WorkspaceError("Could not remove that person.", 500);
  forgetMemberships(userId);
  await audit("member.removed", { type: "member", id: userId }, { role: target.role });
}

// ---------- API keys ----------

export const KEY_NAMES = ["gemini", "anthropic", "hunter"] as const;
export type KeyName = (typeof KEY_NAMES)[number];
export interface KeyStatus { name: KeyName; label: string; workspaceKey: boolean; hint: string | null; updatedAt: string | null; serverFallback: boolean }
const LABEL: Record<KeyName, string> = { gemini: "Gemini (language model)", anthropic: "Anthropic (language model)", hunter: "Hunter.io (contacts)" };
const ENV: Record<KeyName, string> = { gemini: "GEMINI_API_KEY", anthropic: "ANTHROPIC_API_KEY", hunter: "HUNTER_API_KEY" };

/** Which keys are set. Values are never returned, only a hint of the last four characters. */
export async function listKeyStatus(): Promise<{ keys: KeyStatus[]; canStore: boolean }> {
  const c = currentCtx();
  const rows = must<{ name: KeyName; key_hint: string; updated_at: string }[]>(await serviceDb().from("workspace_secrets").select("name, key_hint, updated_at").eq("workspace_id", c.workspaceId), "list keys");
  return {
    canStore: secretsAvailable(),
    keys: KEY_NAMES.map((name) => { const r = rows.find((x) => x.name === name); return { name, label: LABEL[name], workspaceKey: !!r, hint: r?.key_hint ?? null, updatedAt: r?.updated_at ?? null, serverFallback: !!process.env[ENV[name]] }; }),
  };
}

export async function setKey(name: string, value: unknown): Promise<void> {
  requireOwner();
  const c = currentCtx();
  if (!KEY_NAMES.includes(name as KeyName)) throw new WorkspaceError("Unknown key.");
  if (typeof value !== "string") throw new WorkspaceError("Enter the key.");
  const v = value.trim();
  if (v.length < 8 || v.length > 300 || /[\s\u0000-\u001f]/.test(v)) throw new WorkspaceError("That does not look like an API key (8 to 300 characters, no spaces).");
  if (!secretsAvailable()) throw new WorkspaceError("This server has no SECRETS_KEY, so it cannot store keys. Ask whoever runs it to set one.", 503);
  const res = await serviceDb().from("workspace_secrets").upsert({ workspace_id: c.workspaceId, name, ciphertext: encryptSecret(v, `${c.workspaceId}:${name}`), key_hint: keyHint(v), updated_by: c.userId, updated_at: new Date().toISOString() });
  if (res.error) throw new WorkspaceError("Could not save the key.", 500);
  await audit("key.set", { type: "key", id: name }, { name, hint: keyHint(v) }); // the value is never recorded
}

export async function clearKey(name: string): Promise<void> {
  requireOwner();
  const c = currentCtx();
  if (!KEY_NAMES.includes(name as KeyName)) throw new WorkspaceError("Unknown key.");
  await serviceDb().from("workspace_secrets").delete().eq("workspace_id", c.workspaceId).eq("name", name);
  await audit("key.cleared", { type: "key", id: name }, { name });
}

export interface ResolvedKeys { llm: LlmKeys; hunter?: string; has: { llm: boolean; hunter: boolean } }

/** Keys to use for this workspace: its own if set, otherwise the server's. Decrypted only here, for the call that needs them. */
export async function resolveKeys(workspaceId = currentCtx().workspaceId): Promise<ResolvedKeys> {
  const out: Record<string, string> = {};
  if (secretsAvailable()) {
    const rows = (await serviceDb().from("workspace_secrets").select("name, ciphertext").eq("workspace_id", workspaceId)).data as { name: KeyName; ciphertext: string }[] | null;
    for (const r of rows ?? []) { try { out[r.name] = decryptSecret(r.ciphertext, `${workspaceId}:${r.name}`); } catch { /* unreadable: ignore, fall back to the server key */ } }
  }
  const provider = out.gemini ? "gemini" : out.anthropic ? "anthropic" : undefined;
  const envProvider = process.env.LLM_PROVIDER || "gemini";
  const effective = provider ?? envProvider;
  return {
    llm: { provider: provider as LlmKeys["provider"], gemini: out.gemini, anthropic: out.anthropic },
    hunter: out.hunter,
    has: { llm: !!(effective === "anthropic" ? out.anthropic ?? process.env.ANTHROPIC_API_KEY : out.gemini ?? process.env.GEMINI_API_KEY), hunter: !!(out.hunter ?? process.env.HUNTER_API_KEY) },
  };
}

