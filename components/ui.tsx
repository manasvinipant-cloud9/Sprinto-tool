"use client";
import type { ReactNode } from "react";
import { useWorkspace } from "./workspace";

export function Stat({ k, v, s }: { k: string; v: ReactNode; s?: string }) {
  return <div className="stat"><div className="k">{k}</div><div className="v">{v}</div>{s && <div className="s">{s}</div>}</div>;
}

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const { notify } = useWorkspace();
  return (
    <button className="small" onClick={async () => { try { await navigator.clipboard.writeText(text); notify("Copied to clipboard"); } catch { notify("Copy failed. Select the text instead."); } }}>
      {label}
    </button>
  );
}

export function PageHead({ title, lede, children }: { title: string; lede?: string; children?: ReactNode }) {
  return (
    <div className="page-head">
      <div className="panel-head" style={{ marginBottom: 0 }}>
        <h1>{title}</h1>
        {children && <div className="row tight" style={{ marginTop: 0 }}>{children}</div>}
      </div>
      {lede && <p className="lede">{lede}</p>}
    </div>
  );
}

export function download(name: string, text: string, type: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name; a.click(); URL.revokeObjectURL(a.href);
}

export function NextStep({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return <button className="primary" onClick={onClick}>{children}</button>;
}
