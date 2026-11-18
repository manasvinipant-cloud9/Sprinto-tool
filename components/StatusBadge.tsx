import type { Status } from "@/lib/types";

const MAP: Record<Status, { label: string; cls: string }> = {
  sent: { label: "Sent to your inbox", cls: "ok" },
  drafted: { label: "Drafted", cls: "ok" },
  dropped: { label: "Dropped", cls: "bad" },
  qualified_no_poc: { label: "Qualified, no contact", cls: "warn" },
  held: { label: "Held for review", cls: "warn" },
  send_failed: { label: "Send failed", cls: "bad" },
  error: { label: "Error", cls: "bad" },
};

export function StatusBadge({ status }: { status: Status }) {
  const m = MAP[status];
  return <span className={`badge ${m.cls}`}>{m.label}</span>;
}
