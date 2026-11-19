"use client";
import { useEffect, useMemo, useState } from "react";
import { PageHead } from "./ui";
import { useWorkspace } from "./workspace";

interface Override { domain: string; name: string; email: string; title: string; linkedin?: string }

export function ContactsTab() {
  const { api, activeRun, setTab, setSelected, notify } = useWorkspace();
  const [overrides, setOverrides] = useState<Override[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [form, setForm] = useState({ domain: "", name: "", email: "", title: "" });
  useEffect(() => { api<{ overrides: Override[] }>("/api/overrides").then((r) => setOverrides(r.overrides)).catch((e) => setErr((e as Error).message)); }, [api]);

  const picked = useMemo(() => (activeRun?.accounts ?? []).filter((a) => a.brief?.contact), [activeRun]);

  async function add() {
    setErr(null);
    try { setOverrides((await api<{ overrides: Override[] }>("/api/overrides", { method: "POST", body: JSON.stringify(form) })).overrides); setForm({ domain: "", name: "", email: "", title: "" }); notify("Contact saved"); }
    catch (e) { setErr((e as Error).message); }
  }
  async function remove(domain: string) {
    setErr(null);
    try { setOverrides((await api<{ overrides: Override[] }>(`/api/overrides?domain=${encodeURIComponent(domain)}`, { method: "DELETE" })).overrides); }
    catch (e) { setErr((e as Error).message); }
  }

  return (
    <>
      <PageHead title="Contacts" lede="One person per company. A contact you pick by hand wins; otherwise the engine searches Hunter and picks the best title above the confidence bar. Hand-picked contacts belong to this workspace only." />
      <div className="stack">
        <section className="panel">
          <div className="panel-head"><h2>Chosen in this run</h2><span className="muted">{picked.length} contact{picked.length === 1 ? "" : "s"}</span></div>
          {picked.length === 0 ? <p className="muted">No contacts chosen yet. Open a run with results.</p> : (
            <div className="table-wrap"><table>
              <thead><tr><th>Company</th><th>Contact</th><th>Title</th><th className="num">Tier</th><th className="num">Conf.</th></tr></thead>
              <tbody>{picked.map((a) => (
                <tr key={a.id} className="clickable" onClick={() => { setSelected(a.id); setTab("results"); }}>
                  <td className="mono">{a.domain}</td><td>{a.brief!.contact!.name}<div className="faint mono">{a.brief!.contact!.email}</div></td><td>{a.brief!.contact!.title}</td>
                  <td className="num">{a.brief!.contact!.tier ?? "–"}</td><td className="num">{a.brief!.contact!.confidence}</td>
                </tr>))}</tbody>
            </table></div>
          )}
        </section>

        <section className="panel">
          <div className="panel-head"><h2>Hand-picked contacts</h2><span className="muted">used before any Hunter search</span></div>
          {overrides && overrides.length === 0 && <p className="muted">None yet. Add one to force a contact for a company.</p>}
          {overrides && overrides.length > 0 && (
            <div className="table-wrap"><table>
              <thead><tr><th>Domain</th><th>Name</th><th>Title</th><th>Email</th><th /></tr></thead>
              <tbody>{overrides.map((o) => <tr key={o.domain}><td className="mono">{o.domain}</td><td>{o.name}</td><td>{o.title}</td><td className="mono">{o.email}</td><td><button className="ghost small danger" onClick={() => void remove(o.domain)}>Remove</button></td></tr>)}</tbody>
            </table></div>
          )}
          <div className="field-grid" style={{ marginTop: 12 }}>
            <div><label htmlFor="od">Company domain</label><input id="od" type="text" value={form.domain} onChange={(e) => setForm({ ...form, domain: e.target.value })} placeholder="example.com" /></div>
            <div><label htmlFor="on">Name</label><input id="on" type="text" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
            <div><label htmlFor="oe">Email</label><input id="oe" type="text" inputMode="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></div>
            <div><label htmlFor="ot">Title</label><input id="ot" type="text" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></div>
          </div>
          <div className="row"><button onClick={() => void add()} disabled={!form.domain || !form.name || !form.email}>Save contact</button></div>
          {err && <div className="err" role="alert">{err}</div>}
        </section>
      </div>
    </>
  );
}
