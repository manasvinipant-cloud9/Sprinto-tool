"use client";
import { useState } from "react";
import { CompareTab } from "./CompareTab";
import { ContactsTab } from "./ContactsTab";
import { ProfilesTab } from "./ProfilesTab";
import { ResultsTab } from "./ResultsTab";
import { ReviewTab } from "./ReviewTab";
import { RunTab } from "./RunTab";
import { SystemTab } from "./SystemTab";
import { useWorkspace, type TabId } from "./workspace";

export function Shell() {
  const { authed, booting, tab, setTab, driving, activeRun, signIn, signOut, error, theme, setTheme, user, workspaces, current, noWorkspace, switchWorkspace } = useWorkspace();
  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const TABS: { id: TabId; label: string; count?: number; live?: boolean }[] = [
    { id: "run", label: "Run", live: driving },
    { id: "results", label: "Results", count: activeRun?.accounts.length },
    { id: "review", label: "Review" },
    { id: "compare", label: "Compare" },
    { id: "profiles", label: "Profiles" },
    { id: "contacts", label: "Contacts" },
    { id: "system", label: "System" },
  ];
  const dark = theme === "dark";

  async function submit() {
    if (!email || !pw || busy) return;
    setBusy(true);
    await signIn(email, pw);
    setPw("");
    setBusy(false);
  }

  return (
    <>
      <header className="topbar">
        <div className="topbar-in">
          <div className="brand"><span className="brand-mark" aria-hidden>O</span><span className="name">Outreach engine</span></div>
          {authed && !noWorkspace && (
            <nav className="tabs" role="tablist" aria-label="Sections">
              {TABS.map((t) => (
                <button key={t.id} role="tab" className="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)}>
                  {t.label}
                  {t.live && <span className="live" aria-label="running" />}
                  {t.count != null && t.count > 0 && <span className="count">{t.count}</span>}
                </button>
              ))}
            </nav>
          )}
          <div className="topbar-actions" style={{ marginLeft: "auto" }}>
            {authed && workspaces.length > 0 && (
              workspaces.length > 1
                ? <select aria-label="Workspace" value={current?.id ?? ""} onChange={(e) => void switchWorkspace(e.target.value)} className="ws-select">{workspaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</select>
                : <span className="badge plain" title="Your workspace">{current?.name}</span>
            )}
            <span className="badge info plain" title="The app never sends email">Draft only</span>
            <button className="ghost small" aria-label="Toggle theme" onClick={() => setTheme(dark ? "light" : "dark")}>{dark ? "☀" : "☾"}</button>
            {authed && user && <button className="ghost small" onClick={() => void signOut()} title={user.email}>Sign out</button>}
          </div>
        </div>
      </header>
      <main className="shell">
        {booting ? (
          <div className="panel empty login">Loading…</div>
        ) : !authed ? (
          <form className="panel raised login" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
            <h2>Sign in</h2>
            <p className="muted">Use the email and password for your account. Accounts are created by whoever runs this app.</p>
            <label htmlFor="em">Email</label>
            <input id="em" type="text" inputMode="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" autoFocus />
            <label htmlFor="pw">Password</label>
            <input id="pw" type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="current-password" />
            <div className="row"><button className="primary" type="submit" disabled={!email || !pw || busy}>{busy ? "Signing in…" : "Sign in"}</button></div>
            {error && <div className="err" role="alert">{error}</div>}
          </form>
        ) : noWorkspace ? (
          <div className="panel login">
            <h2>No workspace yet</h2>
            <p className="muted">You are signed in as <strong>{user?.email}</strong>, but you have not been added to a workspace. Ask a workspace owner to add you, then reload.</p>
            <div className="row"><button onClick={() => void signOut()}>Sign out</button></div>
          </div>
        ) : (
          <div role="tabpanel">
            {tab === "run" && <RunTab />}
            {tab === "results" && <ResultsTab />}
            {tab === "review" && <ReviewTab />}
            {tab === "compare" && <CompareTab />}
            {tab === "profiles" && <ProfilesTab />}
            {tab === "contacts" && <ContactsTab />}
            {tab === "system" && <SystemTab />}
          </div>
        )}
      </main>
    </>
  );
}
