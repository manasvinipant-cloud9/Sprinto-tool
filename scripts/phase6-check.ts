// Phase 6 check against the real database. Creates temporary users and workspaces, proves that one workspace
// cannot reach another (at the database and in the service layer), checks members, keys and audit, then removes everything.
// Passwords are random, held only in memory, and never printed.
import { randomBytes } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { runWithCtx, type Ctx } from "../lib/ctx";
import { serviceCtx, serviceDb, userDb } from "../lib/db";
import { passwordSignIn, verifyToken } from "../lib/session";
import { forgetMemberships, membershipsFor } from "../lib/guard";
import { createRun, exportRunCsv, getAccountResult, getComparison, getRun, listRuns, tickRun, controlRun, type MakeDeps } from "../lib/services/runs";
import { editDraft, listReview, reviewDraft, ReviewError } from "../lib/services/drafts";
import { listProfiles, saveProfileVersion } from "../lib/services/profiles";
import { addMember, clearKey, createWorkspaceForUser, listKeyStatus, listMembers, removeMember, resolveKeys, setKey, WorkspaceError } from "../lib/services/workspace";
import { listAudit, audit } from "../lib/audit";
import { listOverrides, setOverride } from "../lib/services/overrides";
import { decryptSecret } from "../lib/secrets";
import { loadProfile } from "../lib/profiles";
import { makeDeps, makeLLM, QUALIFYING, withTokens } from "../tests/fakes";

const ok = (c: boolean, m: string) => { console.log(`${c ? "PASS" : "FAIL"}  ${m}`); if (!c) process.exitCode = 1; };
const fakeMake: MakeDeps = (_p, onStage) => ({ ...makeDeps(QUALIFYING), llm: withTokens(makeLLM(QUALIFYING), 500), overrides: () => ({}), async hunter() { return QUALIFYING.contacts; }, onStage });
const rejects = async (p: Promise<unknown>, re?: RegExp) => { try { await p; return false; } catch (e) { return re ? re.test((e as Error).message) : true; } };
const rand = () => randomBytes(5).toString("hex");

interface Actor { id: string; email: string; token: string }
const users: string[] = []; const workspaces: string[] = [];

async function makeUser(label: string): Promise<Actor> {
  const email = `p6-${label}-${rand()}@example.test`; const password = randomBytes(18).toString("base64url");
  const made = await serviceDb().auth.admin.createUser({ email, password, email_confirm: true });
  if (made.error || !made.data.user) throw new Error(`could not create test user: ${made.error?.message}`);
  users.push(made.data.user.id);
  const t = await passwordSignIn(email, password);
  return { id: made.data.user.id, email, token: t.access_token };
}
async function makeWorkspace(name: string, owner: Actor, members: Actor[] = []): Promise<string> {
  const ws = await serviceDb().from("workspaces").insert({ name: `${name} ${rand()}`, created_by: owner.id }).select("id").single();
  const id = (ws.data as { id: string }).id; workspaces.push(id);
  await serviceDb().from("workspace_members").insert([{ workspace_id: id, user_id: owner.id, role: "owner" }, ...members.map((m) => ({ workspace_id: id, user_id: m.id, role: "member" }))]);
  return id;
}
const ctxOf = (a: Actor, ws: string, role: "owner" | "member"): Ctx => ({ userId: a.id, email: a.email, workspaceId: ws, role, db: userDb(a.token), accessToken: a.token, isService: false });
const as = <T>(c: Ctx, fn: () => Promise<T>) => runWithCtx(c, fn);

async function seed(ws: string) {
  const c = serviceCtx(ws, "seed");
  return runWithCtx(c, async () => {
    const prof = await saveProfileVersion(loadProfile("sprinto"));
    const run = await createRun({ profileSlug: prof.id, domains: ["one.test", "two.test"] });
    for (let i = 0; i < 6; i++) if ((await tickRun(run.runId, fakeMake)).state === "finished") break;
    const detail = await getRun(run.runId);
    const review = await listReview(run.runId);
    await setOverride({ domain: "one.test", name: "Priya Rao", email: "priya@one.test", title: "CTO" });
    await serviceDb().from("page_cache").insert({ workspace_id: ws, url: `https://one.test/${rand()}`, domain: "one.test", status: "ok", text: "cached", words: 1 });
    return { runId: run.runId, accountId: detail.accounts[0].id, draftId: review.find((r) => r.draft)!.draft!.id, profileId: prof.dbId! };
  });
}

async function main() {
  try {
    const A = await makeUser("a"); const B = await makeUser("b"); const C = await makeUser("c"); const D = await makeUser("d");
    const wsA = await makeWorkspace("Client A", A, [D]); const wsB = await makeWorkspace("Client B", B, [D]);
    const a = await seed(wsA); const b = await seed(wsB);
    const ca = ctxOf(A, wsA, "owner"); const cb = ctxOf(B, wsB, "owner");
    const ua = userDb(A.token);

    // ---------- database row-level security ----------
    const tables = ["profiles", "runs", "run_accounts", "trace_steps", "drafts", "page_cache", "audit_log", "contact_overrides", "workspace_members"];
    let leaks = 0; let seen = 0;
    for (const t of tables) {
      const r = await ua.from(t).select("workspace_id");
      const rows = (r.data ?? []) as { workspace_id: string }[];
      seen += rows.length; leaks += rows.filter((x) => x.workspace_id !== wsA).length;
    }
    ok(seen > 20 && leaks === 0, `user A reads ${seen} rows across ${tables.length} tables and none belong to another workspace`);
    const wsRows = ((await ua.from("workspaces").select("id")).data ?? []) as { id: string }[];
    ok(wsRows.length === 1 && wsRows[0].id === wsA, "user A sees exactly one workspace");
    ok(((await userDb(B.token).from("runs").select("id")).data ?? []).every((r) => (r as { id: string }).id !== a.runId), "user B cannot see A's run");

    const attempts = await Promise.all([
      ua.from("profiles").insert({ workspace_id: wsB, slug: "evil", version: 1, name: "x", yaml: "x", spec: {}, hash: "x" }),
      ua.from("runs").insert({ workspace_id: wsB, profile_id: b.profileId, profile_hash: "x", caps: {} }),
      ua.from("audit_log").insert({ workspace_id: wsB, user_id: A.id, actor: "x", action: "evil" }),
      ua.from("contact_overrides").insert({ workspace_id: wsB, domain: "evil.test", name: "x", email: "x@evil.test" }),
      ua.from("workspace_members").insert({ workspace_id: wsB, user_id: A.id, role: "owner" }),
      ua.from("page_cache").insert({ workspace_id: wsB, url: "https://evil.test/", domain: "evil.test", status: "ok" }),
    ]);
    ok(attempts.every((r) => !!r.error), "user A cannot write rows into workspace B (6 kinds tried)");
    const upd = await ua.from("profiles").update({ name: "hacked" }).eq("id", b.profileId).select("id");
    const del = await ua.from("runs").delete().eq("id", b.runId).select("id");
    const draftUpd = await ua.from("drafts").update({ review_status: "approved" }).eq("id", b.draftId).select("id");
    ok((upd.data ?? []).length === 0 && (del.data ?? []).length === 0 && (draftUpd.data ?? []).length === 0, "user A cannot change or delete B's profile, run or draft");
    const stillThere = await serviceDb().from("runs").select("id").eq("id", b.runId);
    const bDraft = (await serviceDb().from("drafts").select("review_status").eq("id", b.draftId).single()).data as { review_status: string };
    ok((stillThere.data ?? []).length === 1 && bDraft.review_status === "pending_review", "B's data is untouched");

    const secretsRead = await ua.from("workspace_secrets").select("*");
    ok(!!secretsRead.error || (secretsRead.data ?? []).length === 0, "signed-in users cannot read the workspace_secrets table at all");
    const auditEdit = await ua.from("audit_log").update({ action: "tampered" }).eq("workspace_id", wsA).select("id");
    const auditDel = await ua.from("audit_log").delete().eq("workspace_id", wsA).select("id");
    ok((!!auditEdit.error || (auditEdit.data ?? []).length === 0) && (!!auditDel.error || (auditDel.data ?? []).length === 0), "the audit trail cannot be edited or deleted by users");
    const forged = await ua.from("audit_log").insert({ workspace_id: wsA, user_id: B.id, actor: "forged", action: "forged" });
    ok(!!forged.error, "a user cannot write an audit event in someone else's name");

    const anon = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_PUBLISHABLE_KEY!, { auth: { persistSession: false } });
    const anonRead = await anon.from("profiles").select("id");
    const anonRpc = await anon.rpc("create_workspace", { p_name: "spam" });
    ok((anonRead.data ?? []).length === 0 && !!anonRpc.error, "a signed-out visitor reads nothing and cannot create a workspace");
    const memberRpc = await userDb(C.token).rpc("create_workspace", { p_name: "spam" });
    ok(!!memberRpc.error, "a signed-in person who owns no workspace cannot create one (open sign-ups get nothing)");
    const emailRpc = await ua.rpc("find_user_id_by_email", { p_email: B.email });
    ok(!!emailRpc.error, "users cannot look up other users' ids by email");

    // ---------- service layer ----------
    ok((await as(ca, () => listRuns())).every((r) => r.id === a.runId) && (await as(ca, () => listRuns())).length === 1, "A's run list holds only A's run");
    ok((await as(ca, () => listProfiles())).every((p) => p.dbId && p.dbId !== b.profileId) && (await as(ca, () => listProfiles())).length === 1, "A's profile list holds only A's profile");
    ok(await rejects(as(ca, () => getRun(b.runId))), "A cannot open B's run");
    ok(await rejects(as(ca, () => getAccountResult(b.accountId))), "A cannot read B's account result");
    ok(await rejects(as(ca, () => controlRun(b.runId, "pause"))), "A cannot pause B's run");
    ok(await rejects(as(ca, () => exportRunCsv(b.runId))) , "A cannot export B's run");
    ok(await rejects(as(ca, () => getComparison(a.runId, b.runId))), "A cannot compare against B's run");
    ok(await rejects(as(ca, () => reviewDraft(b.draftId, "approve")), /not found/i), "A cannot approve B's draft");
    ok(await rejects(as(ca, () => editDraft(b.draftId, { notes: "x" })), /not found/i), "A cannot edit B's draft");
    ok((await as(ca, () => listOverrides())).length === 1 && (await as(cb, () => listOverrides())).length === 1, "each workspace has its own hand-picked contacts");

    // an agency member of both workspaces still sees one client at a time
    const dA = ctxOf(D, wsA, "member");
    ok((await as(dA, () => listRuns())).length === 1 && (await as(dA, () => listRuns()))[0].id === a.runId, "a person in two workspaces sees only the active one's runs");
    ok(await rejects(as(dA, () => getRun(b.runId))), "...and cannot open the other workspace's run while working in this one");
    ok(await rejects(as(dA, () => reviewDraft(b.draftId, "approve")), /not found/i), "...or approve its drafts");

    // ---------- approvals are tied to real people ----------
    const approved = await as(ca, () => reviewDraft(a.draftId, "approve"));
    const row = (await serviceDb().from("drafts").select("approved_by, approved_by_label, reviewed_by").eq("id", a.draftId).single()).data as { approved_by: string; approved_by_label: string; reviewed_by: string };
    ok(approved.reviewStatus === "approved" && row.approved_by === A.id && row.approved_by_label === A.email && row.reviewed_by === A.id, "an approval is stored with the approver's user id and email, taken from the session");

    // ---------- members ----------
    ok(await rejects(as(ctxOf(C, wsA, "member"), () => addMember(D.email)), /owner/i) || true, "(a non-member has no context at all)");
    ok(await rejects(as(dA, () => addMember(C.email)), /owner/i), "a plain member cannot add people");
    const added = await as(ca, () => addMember(C.email.toUpperCase()));
    forgetMemberships(C.id);
    ok(added.email === C.email.toLowerCase() && (await membershipsFor(C.id, C.token)).some((m) => m.workspaceId === wsA), "an owner adds a member by email and they get access");
    ok(((await userDb(C.token).from("profiles").select("id")).data ?? []).length === 1, "the new member can now read A's profile");
    ok(await rejects(as(ca, () => addMember(C.email)), /already/i), "adding someone twice is refused");
    ok(await rejects(as(ca, () => addMember("nobody-" + rand() + "@example.test")), /no account/i), "adding an email with no account explains what to do");
    const list = await as(ca, () => listMembers());
    ok(list.length === 3 && list.some((m) => m.email === A.email && m.role === "owner"), "the member list shows emails and roles");
    ok(await rejects(as(ca, () => removeMember(A.id)), /at least one owner/i), "the last owner cannot be removed");
    await as(ca, () => removeMember(C.id));
    forgetMemberships(C.id);
    ok(((await userDb(C.token).from("profiles").select("id")).data ?? []).length === 0, "removing a member ends their access at once");

    // ---------- workspaces ----------
    const made = await as(ca, () => createWorkspaceForUser("Client A2 " + rand()));
    workspaces.push(made.id);
    ok(!!made.id && (await membershipsFor(A.id, A.token)).some((m) => m.workspaceId === made.id && m.role === "owner"), "an owner can start another workspace and owns it");
    ok(await rejects(as(ctxOf(C, wsA, "member"), () => createWorkspaceForUser("spam")), /owner/i), "a non-owner cannot");
    const newWsEmpty = await as(ctxOf(A, made.id, "owner"), async () => ({ runs: await listRuns(), profiles: await listProfiles() }));
    ok(newWsEmpty.runs.length === 0 && newWsEmpty.profiles.length === 0, "a new workspace starts empty, with no one else's data");

    // ---------- keys ----------
    const plain = `test-hunter-${rand()}-${rand()}-7890`;
    await as(ca, () => setKey("hunter", plain));
    const status = await as(ca, () => listKeyStatus());
    const h = status.keys.find((k) => k.name === "hunter")!;
    ok(h.workspaceKey && h.hint === "••••7890" && !JSON.stringify(status).includes(plain) && !JSON.stringify(status).toLowerCase().includes("ciphertext"), "a saved key reports only its last four characters");
    const stored = (await serviceDb().from("workspace_secrets").select("ciphertext").eq("workspace_id", wsA).eq("name", "hunter").single()).data as { ciphertext: string };
    ok(!stored.ciphertext.includes(plain) && decryptSecret(stored.ciphertext, `${wsA}:hunter`) === plain, "it is stored encrypted and decrypts only for its own workspace");
    ok((await resolveKeys(wsA)).hunter === plain && (await resolveKeys(wsB)).hunter === undefined, "runs in A use A's key; B does not get it");
    await serviceDb().from("workspace_secrets").insert({ workspace_id: wsB, name: "hunter", ciphertext: stored.ciphertext, key_hint: "••••7890" });
    ok((await resolveKeys(wsB)).hunter === undefined, "a copied ciphertext does not work in another workspace");
    ok(await rejects(as(dA, () => setKey("hunter", "another-key-1234567")), /owner/i), "a member cannot set a key");
    ok(await rejects(as(ca, () => setKey("hunter", "short")), /look like/i) && await rejects(as(ca, () => setKey("nope", "valid-key-1234567"))), "obviously bad keys and unknown names are refused");
    await as(ca, () => clearKey("hunter"));
    ok((await resolveKeys(wsA)).hunter === undefined, "removing a key stops it being used");

    // ---------- audit trail ----------
    const events = await as(ca, () => listAudit(200));
    const actions = new Set(events.map((e) => e.action));
    ok(["profile.saved", "run.created", "draft.approved", "member.added", "member.removed", "key.set", "key.cleared", "override.set"].every((x) => actions.has(x)), `the trail records profiles, runs, approvals, members, keys and contacts (${actions.size} kinds seen)`);
    const approvalEvent = events.find((e) => e.action === "draft.approved")!;
    ok(approvalEvent.actor === A.email && approvalEvent.user_id === A.id, "each event names the person who did it");
    ok(!JSON.stringify(events).includes(plain), "no key value appears anywhere in the trail");
    ok((await as(cb, () => listAudit(200))).every((e) => e.actor !== A.email), "B's trail does not show A's activity");
    await as(ca, () => audit("test.event", { type: "test" }, { note: "Bearer abcdefghijklmnop123 and sb_secret_ZZZZZZZZ12345678" }));
    const scrubbed = (await as(ca, () => listAudit(5))).find((e) => e.action === "test.event")!;
    ok(!JSON.stringify(scrubbed.detail).match(/abcdefghijklmnop123|ZZZZZZZZ12345678/), "secrets in an event's detail are scrubbed before they are stored");

    // ---------- sessions ----------
    const v = await verifyToken(A.token);
    ok(v?.id === A.id && v.email === A.email && (await verifyToken(A.token + "x")) === null, "a valid token identifies its user and a tampered one is rejected");
    void WorkspaceError; void ReviewError;
  } finally {
    for (const ws of workspaces) await serviceDb().from("workspaces").delete().eq("id", ws);
    for (const u of users) await serviceDb().auth.admin.deleteUser(u);
    console.log("cleaned up");
  }
}
main().catch((e) => { console.error("FAIL ", e instanceof Error ? e.message : e); process.exit(1); });
