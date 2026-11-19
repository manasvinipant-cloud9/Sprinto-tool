import type { Profile } from "./profile-schema";
import type { Candidate, TierLogEntry } from "./types";

export interface RawContact { name: string; email: string; title: string; confidence: number }

export function pickContact(
  profile: Profile,
  raw: RawContact[],
  headcount: number | null,
): { contact: Candidate | null; considered: Candidate[]; tierLog: TierLogEntry[] } {
  const min = profile.limits.hunter_min_confidence;
  const considered: Candidate[] = raw.slice(0, profile.limits.max_contacts_per_account).map((r) => ({ ...r, tier: null, reason: "no persona tier matched" }));

  const tiers = [...profile.personas].sort((a, b) => a.tier - b.tier);
  const tierLog: TierLogEntry[] = [];
  for (const persona of tiers) {
    if (persona.applies_when !== "always" && headcount !== null && headcount >= persona.applies_when.headcount_below) {
      tierLog.push({ tier: persona.tier, applies: false, skipped_reason: `company has ${headcount} people; this tier only applies below ${persona.applies_when.headcount_below}`, title_matches: 0, excluded: 0, below_confidence: 0, qualified: 0 });
      continue;
    }
    const entry: TierLogEntry = { tier: persona.tier, applies: true, title_matches: 0, excluded: 0, below_confidence: 0, qualified: 0 };
    tierLog.push(entry);
    const matches: Candidate[] = [];
    for (const c of considered) {
      const t = c.title.toLowerCase();
      if (!persona.titles.some((x) => t.includes(x.toLowerCase()))) continue;
      entry.title_matches++;
      if (persona.exclude_titles.some((x) => t.includes(x.toLowerCase()))) {
        c.reason = `excluded title for tier ${persona.tier}`;
        entry.excluded++;
        continue;
      }
      if (c.confidence < min) {
        entry.below_confidence++;
        c.tier = persona.tier;
        c.reason = `tier ${persona.tier} title but confidence ${c.confidence} is below ${min}`;
        continue;
      }
      c.tier = persona.tier;
      c.reason = `tier ${persona.tier} title match with confidence ${c.confidence}`;
      entry.qualified++;
      matches.push(c);
    }
    if (matches.length) {
      matches.sort((a, b) => b.confidence - a.confidence);
      const win = matches[0];
      win.reason += matches.length > 1 ? ` (highest of ${matches.length} in this tier)` : "";
      for (const c of considered) if (c !== win && c.tier === null && !c.reason.startsWith("excluded")) c.reason = "lower tier than the chosen contact or no match";
      for (const rest of tiers.filter((t) => t.tier > persona.tier)) tierLog.push({ tier: rest.tier, applies: true, not_reached: true, title_matches: 0, excluded: 0, below_confidence: 0, qualified: 0 });
      return { contact: win, considered, tierLog };
    }
  }
  return { contact: null, considered, tierLog };
}

export interface HunterAccount { used: number | null; available: number | null }

export async function hunterAccount(apiKey?: string): Promise<HunterAccount> {
  const res = await fetch(`https://api.hunter.io/v2/account?api_key=${encodeURIComponent(apiKey ?? process.env.HUNTER_API_KEY ?? "")}`);
  if (!res.ok) throw Object.assign(new Error(`hunter_${res.status}`), { status: res.status });
  const j = (await res.json()) as { data?: { requests?: { searches?: { used?: number; available?: number } } } };
  const s = j.data?.requests?.searches;
  return { used: s?.used ?? null, available: s?.available ?? null };
}

export async function hunterSearch(domain: string, apiKey?: string): Promise<RawContact[]> {
  const url = `https://api.hunter.io/v2/domain-search?domain=${encodeURIComponent(domain)}&limit=10&api_key=${encodeURIComponent(apiKey ?? process.env.HUNTER_API_KEY ?? "")}`;
  let lastStatus = 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url);
      lastStatus = res.status;
      if (res.status === 401 || res.status === 403) throw Object.assign(new Error("hunter_auth"), { permanent: true });
      if (res.status === 429) {
        const j = (await res.json().catch(() => ({}))) as { errors?: { id?: string }[] };
        if (j.errors?.some((e) => /usage|limit|quota/i.test(e.id ?? ""))) throw Object.assign(new Error("hunter_quota"), { permanent: true });
        await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
        continue;
      }
      if (res.status >= 500) {
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
        continue;
      }
      if (!res.ok) throw Object.assign(new Error(`hunter_${res.status}`), { permanent: true });
      const j = (await res.json()) as { data?: { emails?: { value: string; confidence?: number; first_name?: string; last_name?: string; position?: string | null }[] } };
      return (j.data?.emails ?? []).map((e) => ({
        name: [e.first_name, e.last_name].filter(Boolean).join(" ") || e.value.split("@")[0],
        email: e.value,
        title: e.position ?? "",
        confidence: e.confidence ?? 0,
      }));
    } catch (e) {
      if ((e as { permanent?: boolean }).permanent) throw e;
      if (attempt === 2) throw Object.assign(new Error(`hunter_network_${lastStatus}`), { permanent: false });
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
  throw new Error("hunter_unavailable");
}
