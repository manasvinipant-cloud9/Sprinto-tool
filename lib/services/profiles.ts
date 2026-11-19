import YAML from "yaml";
import { db, must } from "../db";
import { currentCtx, currentWorkspaceId } from "../ctx";
import { audit } from "../audit";
import { listProfileIds, loadProfile } from "../profiles";
import { profileSchema, type Profile } from "../profile-schema";
import { profileHash } from "../profile-hash";

export interface ProfileVersion { dbId: string; version: number; hash: string; created_at: string }
export interface ProfileRecord {
  id: string;          // slug, stable across versions
  dbId: string | null; // row id of this version (null when served from files)
  version: number; seller: string; icp: string; hash: string;
  gates: { id: string; question: string }[];
  detail: Profile; yaml: string;
  clonedFrom: string | null;
  versions: ProfileVersion[];
  readonly: boolean;
}

export const dbConfigured = () => Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);

interface Row { id: string; slug: string; version: number; hash: string; spec: unknown; yaml: string; cloned_from: string | null; created_at: string }

function toRecord(latest: Row, all: Row[], slugById: Map<string, string>): ProfileRecord {
  const spec = profileSchema.parse(latest.spec);
  return {
    id: latest.slug, dbId: latest.id, version: latest.version, seller: spec.seller.name, icp: spec.icp_summary, hash: latest.hash,
    gates: spec.gates.map((g) => ({ id: g.id, question: g.question })), detail: spec, yaml: latest.yaml,
    clonedFrom: latest.cloned_from ? slugById.get(latest.cloned_from) ?? null : null,
    versions: all.filter((r) => r.slug === latest.slug).sort((a, b) => b.version - a.version).map((r) => ({ dbId: r.id, version: r.version, hash: r.hash, created_at: r.created_at })),
    readonly: false,
  };
}

async function allRows(ws: string): Promise<Row[]> {
  return must<Row[]>(await db().from("profiles").select("id, slug, version, hash, spec, yaml, cloned_from, created_at").eq("workspace_id", ws), "list profiles");
}

/** Copies the shipped example profiles into the current workspace (skipping any slug it already has). */
export async function seedExamples(): Promise<number> {
  const ws = currentWorkspaceId();
  const have = new Set((await allRows(ws)).map((r) => r.slug));
  let n = 0;
  for (const id of listProfileIds()) {
    if (have.has(id)) continue;
    const p = loadProfile(id);
    must(await db().from("profiles").insert({ workspace_id: ws, slug: p.id, version: p.version, name: p.seller.name, yaml: YAML.stringify(p), spec: p, hash: profileHash(p), created_by: currentCtx().userId }).select("id").single(), "seed profile");
    n++;
  }
  if (n) await audit("profile.examples_imported", { type: "profile" }, { count: n });
  return n;
}

export async function listProfiles(): Promise<ProfileRecord[]> {
  if (!dbConfigured()) {
    return listProfileIds().map((id) => {
      const p = loadProfile(id);
      return { id: p.id, dbId: null, version: p.version, seller: p.seller.name, icp: p.icp_summary, hash: profileHash(p), gates: p.gates.map((g) => ({ id: g.id, question: g.question })), detail: p, yaml: YAML.stringify(p), clonedFrom: null, versions: [], readonly: true };
    });
  }
  const ws = currentWorkspaceId();
  const rows = await allRows(ws);
  const slugById = new Map(rows.map((r) => [r.id, r.slug]));
  const latest = new Map<string, Row>();
  for (const r of rows) { const cur = latest.get(r.slug); if (!cur || r.version > cur.version) latest.set(r.slug, r); }
  return [...latest.values()].sort((a, b) => a.slug.localeCompare(b.slug)).map((r) => toRecord(r, rows, slugById));
}

/** Resolve the exact profile for a run: a specific version row, or the latest of a slug. */
export async function resolveProfile(slug: string, dbId?: string): Promise<Profile> {
  if (!dbConfigured()) return loadProfile(slug);
  const ws = currentWorkspaceId();
  const q = db().from("profiles").select("spec").eq("workspace_id", ws);
  const res = dbId ? await q.eq("id", dbId).limit(1) : await q.eq("slug", slug).order("version", { ascending: false }).limit(1);
  if (res.error || !res.data?.length) throw new Error("Unknown profile.");
  return profileSchema.parse((res.data[0] as { spec: unknown }).spec);
}

/** Saves an immutable new version. An edit of an existing slug becomes version n+1. */
export async function saveProfileVersion(spec: Profile, opts: { cloneOfDbId?: string } = {}): Promise<ProfileRecord> {
  if (!dbConfigured()) throw Object.assign(new Error("Saving needs the database (set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY)."), { status: 503 });
  const ws = currentWorkspaceId();
  const existing = (await allRows(ws)).filter((r) => r.slug === spec.id);
  const version = existing.length ? Math.max(...existing.map((r) => r.version)) + 1 : 1;
  const final: Profile = { ...spec, version };
  must(await db().from("profiles").insert({ workspace_id: ws, slug: final.id, version, name: final.seller.name, yaml: YAML.stringify(final), spec: final, hash: profileHash(final), cloned_from: opts.cloneOfDbId ?? null, created_by: currentCtx().userId }).select("id").single(), "save profile");
  await audit(opts.cloneOfDbId ? "profile.cloned" : "profile.saved", { type: "profile", id: final.id }, { slug: final.id, version, hash: profileHash(final), cloned_from: opts.cloneOfDbId ?? null });
  return (await listProfiles()).find((p) => p.id === final.id)!;
}

export async function uniqueSlug(base: string): Promise<string> {
  const taken = new Set((await listProfiles()).map((p) => p.id));
  let slug = `${base}-copy`; let n = 2;
  while (taken.has(slug)) slug = `${base}-copy-${n++}`;
  return slug;
}

/** The exact stored version a run will use. Runs point at an immutable row, never at "latest". */
export async function resolveProfileRow(slug: string, dbId?: string): Promise<{ dbId: string; spec: Profile; hash: string }> {
  if (!dbConfigured()) throw new Error("Runs need the database (set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY).");
  const ws = currentWorkspaceId();
  const q = db().from("profiles").select("id, spec, hash").eq("workspace_id", ws);
  const res = dbId ? await q.eq("id", dbId).limit(1) : await q.eq("slug", slug).order("version", { ascending: false }).limit(1);
  if (res.error || !res.data?.length) throw new Error("Unknown profile.");
  const row = res.data[0] as { id: string; spec: unknown; hash: string };
  return { dbId: row.id, spec: profileSchema.parse(row.spec), hash: row.hash };
}
