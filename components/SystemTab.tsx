"use client";
import { useCallback, useEffect, useState } from "react";
import type { AuditEvent } from "@/lib/audit";
import type { KeyStatus, Member } from "@/lib/services/workspace";
import { PageHead } from "./ui";
import { useWorkspace } from "./workspace";

const ITEMS: { key: "llm" | "hunter" | "database"; name: string; what: string }[] = [
  { key: "llm", name: "Language model", what: "Extracts facts, answers gates, writes pains and the email." },
  { key: "hunter", name: "Hunter.io", what: "Finds a named contact at the company." },
  { key: "database", name: "Database", what: "Stores profiles, runs, drafts and the page cache." },
];
const when = (iso: string) => new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "medium" });

function Members({ owner }: { owner: boolean }) {
  const { api, user, notify } = useWorkspace();
  const [members, setMembers] = useState<Member[] | null>(null);
  const [email, setEmail] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(async () => { try { setMembers((await api<{ members: Member[] }>("/api/members")).members); } catch (e) { setErr((e as Error).message); } }, [api]);
  useEffect(() => { void load(); }, [load]);
  async function add() {
    setErr(null);
    try { await api("/api/members", { method: "POST", body: JSON.stringify({ email }) }); setEmail(""); notify("Member added"); await load(); } catch (e) { setErr((e as Error).message); }
  }
  async function remove(m: Member) {
    if (!confirm(`Remove ${m.email} from this workspace? They lose access to its runs, drafts and profiles.`)) return;
    setErr(null);
    try { await api(`/api/members?user=${m.userId}`, { method: "DELETE" }); notify("Member removed"); await load(); } catch (e) { setErr((e as Error).message); }
  }
  return (
    <>
      <h3>Members</h3>
      {members && (
        <div className="table-wrap"><table>
          <thead><tr><th>Email</th><th>Role</th><th>Since</th><th /></tr></thead>
          <tbody>{members.map((m) => (
            <tr key={m.userId}><td>{m.email}{m.userId === user?.id && <span className="badge plain info" style={{ marginLeft: 6 }}>you</span>}</td><td>{m.role}</td><td>{when(m.since)}</td>
              <td>{owner && m.userId !== user?.id && <button className="ghost small danger" onClick={() => void remove(m)}>Remove</button>}</td></tr>))}</tbody>
        </table></div>
      )}
      {owner ? (
        <div className="row tight">
          <input type="text" inputMode="email" placeholder="Their email" aria-label="Email of the person to add" value={email} onChange={(e) => setEmail(e.target.value)} style={{ maxWidth: 280 }} onKeyDown={(e) => { if (e.key === "Enter" && email) void add(); }} />
          <button onClick={() => void add()} disabled={!email}>Add member</button>
        </div>
      ) : <p className="hint">Only an owner can add or remove members.</p>}
      <p className="hint">People need an account first. Whoever runs this app creates it with <code>npm run add-user</code>; there is no open sign-up.</p>
      {err && <div className="err" role="alert">{err}</div>}
    </>
  );
}

function Keys({ owner }: { owner: boolean }) {
  const { api, notify, refreshStatus } = useWorkspace();
  const [data, setData] = useState<{ keys: KeyStatus[]; canStore: boolean } | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(async () => { try { setData(await api("/api/keys")); } catch (e) { setErr((e as Error).message); } }, [api]);
  useEffect(() => { void load(); }, [load]);
  async function save(name: string) {
    setErr(null);
    try { setData(await api("/api/keys", { method: "PUT", body: JSON.stringify({ name, value: draft[name] ?? "" }) })); setDraft((d) => ({ ...d, [name]: "" })); notify("Key saved"); refreshStatus(); } catch (e) { setErr((e as Error).message); }
  }
  async function clear(name: string) {
    if (!confirm("Remove this workspace's key? Runs will use the server's shared key if there is one, otherwise they will stop.")) return;
    setErr(null);
    try { setData(await api(`/api/keys?name=${name}`, { method: "DELETE" })); notify("Key removed"); refreshStatus(); } catch (e) { setErr((e as Error).message); }
  }
  return (
    <>
      <h3>API keys for this workspace</h3>
      <p className="hint" style={{ marginTop: 0 }}>A workspace can use its own keys, so a client's usage and quota stay separate. Keys are encrypted on the server and never shown again; only the last four characters are.</p>
      {data && !data.canStore && <div className="banner warn"><span>This server is not set up to store workspace keys, so it will use the shared server keys instead. Ask whoever runs the app to enable it.</span></div>}
      {data && (
        <div className="table-wrap"><table>
          <thead><tr><th>Service</th><th>Using</th>{owner && <th>Set or replace</th>}</tr></thead>
          <tbody>{data.keys.map((k) => (
            <tr key={k.name}>
              <td><strong>{k.label}</strong></td>
              <td>{k.workspaceKey ? <><span className="badge ok">workspace key</span> <span className="mono faint">{k.hint}</span><div className="faint" style={{ fontSize: 12 }}>updated {k.updatedAt ? when(k.updatedAt) : ""}</div></> : k.serverFallback ? <span className="badge info">shared server key</span> : <span className="badge bad">none</span>}</td>
              {owner && (
                <td>
                  <div className="row tight" style={{ margin: 0 }}>
                    <input type="password" autoComplete="off" spellCheck={false} placeholder="Paste key" aria-label={`New ${k.label} key`} value={draft[k.name] ?? ""} onChange={(e) => setDraft({ ...draft, [k.name]: e.target.value })} disabled={!data.canStore} style={{ width: 200 }} />
                    <button className="small" onClick={() => void save(k.name)} disabled={!data.canStore || !(draft[k.name] ?? "").trim()}>Save</button>
                    {k.workspaceKey && <button className="ghost small danger" onClick={() => void clear(k.name)}>Remove</button>}
                  </div>
                </td>
              )}
            </tr>))}</tbody>
        </table></div>
      )}
      {!owner && <p className="hint">Only an owner can change keys.</p>}
      {err && <div className="err" role="alert">{err}</div>}
    </>
  );
}

function Audit() {
  const { api } = useWorkspace();
  const [events, setEvents] = useState<AuditEvent[] | null>(null);
  const [more, setMore] = useState(true);
  const [q, setQ] = useState("");
  const load = useCallback(async (before?: number) => {
    const r = await api<{ events: AuditEvent[] }>(`/api/audit?limit=50${before ? `&before=${before}` : ""}`);
    setEvents((prev) => (before ? [...(prev ?? []), ...r.events] : r.events)); setMore(r.events.length === 50);
  }, [api]);
  useEffect(() => { void load().catch(() => setEvents([])); }, [load]);
  const shown = (events ?? []).filter((e) => !q || `${e.actor} ${e.action} ${e.entity_type ?? ""} ${JSON.stringify(e.detail)}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <>
      <div className="panel-head"><h3 style={{ margin: 0 }}>Audit trail</h3><div className="row tight" style={{ marginTop: 0 }}><input type="text" placeholder="Filter" aria-label="Filter the audit trail" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 180 }} /><button className="small" onClick={() => void load()}>Refresh</button></div></div>
      <p className="hint">Who did what in this workspace. It can only be added to, not edited or deleted. Key values are never recorded.</p>
      {events === null ? <p className="muted">Loading…</p> : shown.length === 0 ? <p className="muted">Nothing yet.</p> : (
        <div className="table-wrap"><table>
          <thead><tr><th>When</th><th>Who</th><th>What</th><th>Detail</th></tr></thead>
          <tbody>{shown.map((e) => (
            <tr key={e.id}><td style={{ whiteSpace: "nowrap" }}>{when(e.created_at)}</td><td>{e.actor || "system"}</td><td><span className="tag">{e.action}</span></td>
              <td className="mono" style={{ fontSize: 12, wordBreak: "break-word" }}>{Object.entries(e.detail).map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(",") : String(v)}`).join("  ")}</td></tr>))}</tbody>
        </table></div>
      )}
      {more && events && events.length > 0 && <div className="row"><button onClick={() => void load(events[events.length - 1].id)}>Load older</button></div>}
    </>
  );
}

export function SystemTab() {
  const { status, refreshStatus, theme, setTheme, signOut, current, user, demo, api, createWorkspace, notify, refreshSession } = useWorkspace();
  const owner = current?.role === "owner";
  const [newName, setNewName] = useState("");
  const [rename, setRename] = useState(current?.name ?? "");
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { setRename(current?.name ?? ""); }, [current?.name]);

  async function create() {
    setErr(null);
    try { await createWorkspace(newName); setNewName(""); notify("Workspace created. You are now in it."); } catch (e) { setErr((e as Error).message); }
  }
  async function doRename() {
    setErr(null);
    try { await api("/api/workspaces", { method: "PATCH", body: JSON.stringify({ name: rename }) }); await refreshSession(); notify("Renamed"); } catch (e) { setErr((e as Error).message); }
  }

  return (
    <>
      <PageHead title="System" lede="Your workspace, who is in it, its keys, and a record of what has been done. Everything here belongs to the workspace you are in.">
        <button onClick={refreshStatus}>Refresh</button>
      </PageHead>
      <div className="stack">
        <section className="panel">
          <div className="panel-head"><h2>Workspace: {current?.name}</h2><span className="badge plain">{owner ? "you are an owner" : "you are a member"}</span></div>
          <p className="muted" style={{ marginTop: 0 }}>Profiles, domain lists, runs, drafts, contacts and keys are kept per workspace. Someone in another workspace cannot see any of it.</p>
          {owner && (
            <div className="row tight" style={{ marginTop: 0 }}>
              <input type="text" aria-label="Workspace name" value={rename} onChange={(e) => setRename(e.target.value)} maxLength={80} style={{ maxWidth: 280 }} />
              <button onClick={() => void doRename()} disabled={!rename.trim() || rename.trim() === current?.name}>Rename</button>
            </div>
          )}
          {!demo && <Members owner={owner} />}
          {owner && !demo && (
            <>
              <h3>Add a workspace (for example a new client)</h3>
              <div className="row tight" style={{ marginTop: 0 }}>
                <input type="text" placeholder="Workspace name" aria-label="New workspace name" value={newName} onChange={(e) => setNewName(e.target.value)} maxLength={80} style={{ maxWidth: 280 }} />
                <button onClick={() => void create()} disabled={!newName.trim()}>Create and switch</button>
              </div>
            </>
          )}
          {err && <div className="err" role="alert">{err}</div>}
        </section>

        {!demo && <section className="panel"><Keys owner={owner} /></section>}

        <section className="panel">
          <div className="panel-head"><h2>Connections</h2></div>
          <div className="table-wrap"><table>
            <thead><tr><th>Service</th><th>State for this workspace</th><th>What it does</th></tr></thead>
            <tbody>{ITEMS.map((i) => (
              <tr key={i.key}><td><strong>{i.name}</strong></td>
                <td>{!status ? <span className="badge plain">checking</span> : status.configured[i.key] ? <span className="badge ok">set</span> : <span className="badge bad">missing</span>}</td>
                <td>{i.what}</td></tr>))}</tbody>
          </table></div>
          {status?.hunter?.available != null && (
            <p style={{ marginTop: 12 }}>Hunter searches left this month: <strong className="mono">{status.hunter.available}</strong>{status.hunter.used != null && <span className="muted"> ({status.hunter.used} used)</span>}</p>
          )}
        </section>

        {!demo && <section className="panel"><Audit /></section>}

        <section className="panel">
          <div className="panel-head"><h2>Guard rails</h2></div>
          <ul style={{ margin: 0, paddingLeft: 20 }}>
            <li>No email is ever sent. The app has no mail-sending code at all; approved drafts are exported for a human to send.</li>
            <li>Each workspace is isolated in the database itself, not only in the app: a signed-in user can only read rows from workspaces they belong to.</li>
            <li>One page fetched at a time. robots.txt respected. Never behind a login or around a bot check.</li>
            <li>Hard caps on page fetches, searches and tokens per account, set in the profile and enforced in code.</li>
            <li>Only public site text and a contact’s name and title reach the model.</li>
          </ul>
        </section>

        <section className="panel">
          <div className="panel-head"><h2>You</h2></div>
          <p className="muted" style={{ marginTop: 0 }}>Signed in as <strong>{user?.email}</strong>. Approvals and edits are recorded under this account.</p>
          <label htmlFor="theme">Theme</label>
          <select id="theme" value={theme} onChange={(e) => setTheme(e.target.value as "system" | "light" | "dark")} style={{ maxWidth: 220 }}>
            <option value="system">Match my system</option><option value="light">Light</option><option value="dark">Dark</option>
          </select>
          <div className="row"><button onClick={() => void signOut()}>Sign out</button></div>
        </section>
      </div>
    </>
  );
}
