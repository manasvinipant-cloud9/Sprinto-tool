import { audit } from "../audit";
import { currentCtx, currentWorkspaceId } from "../ctx";
import { db, must } from "../db";
import { normalizeDomain } from "../pipeline";

export interface Override { domain: string; name: string; email: string; title: string; linkedin?: string }
export class OverrideError extends Error { constructor(message: string, public status = 400) { super(message); } }

export async function listOverrides(): Promise<Override[]> {
  const rows = must<(Override & { linkedin: string | null })[]>(await db().from("contact_overrides").select("domain, name, email, title, linkedin").eq("workspace_id", currentWorkspaceId()).order("domain"), "list overrides");
  return rows.map((r) => ({ domain: r.domain, name: r.name, email: r.email, title: r.title, ...(r.linkedin ? { linkedin: r.linkedin } : {}) }));
}

/** Hand-picked contacts for one workspace. They win over a Hunter search, and are never shared with another workspace. */
export async function overridesMap(): Promise<Record<string, { name: string; email: string; title: string }>> {
  return Object.fromEntries((await listOverrides()).map((o) => [o.domain, { name: o.name, email: o.email, title: o.title }]));
}

export async function setOverride(input: { domain: string; name: string; email: string; title?: string; linkedin?: string }): Promise<Override> {
  const domain = normalizeDomain(input.domain ?? "");
  const name = (input.name ?? "").trim(); const email = (input.email ?? "").trim().toLowerCase(); const title = (input.title ?? "").trim();
  if (!domain) throw new OverrideError("Enter the company's domain.");
  if (!name || name.length > 120) throw new OverrideError("Enter the person's name.");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 200) throw new OverrideError("Enter a valid email address.");
  if (title.length > 120) throw new OverrideError("The title is too long.");
  const linkedin = (input.linkedin ?? "").trim();
  if (linkedin && !/^https:\/\/([a-z]+\.)?linkedin\.com\//i.test(linkedin)) throw new OverrideError("A LinkedIn link must start with https://www.linkedin.com/");
  must(await db().from("contact_overrides").upsert({ workspace_id: currentWorkspaceId(), domain, name, email, title, linkedin: linkedin || null, created_by: currentCtx().userId }).select("domain"), "save override");
  await audit("override.set", { type: "override", id: domain }, { domain, email });
  return { domain, name, email, title, ...(linkedin ? { linkedin } : {}) };
}

export async function deleteOverride(domainRaw: string): Promise<void> {
  const domain = normalizeDomain(domainRaw);
  if (!domain) throw new OverrideError("Invalid domain.");
  must(await db().from("contact_overrides").delete().eq("workspace_id", currentWorkspaceId()).eq("domain", domain).select("domain"), "delete override");
  await audit("override.deleted", { type: "override", id: domain }, { domain });
}
