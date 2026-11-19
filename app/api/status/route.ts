import { withAuth } from "@/lib/guard";
import { hunterAccount } from "@/lib/poc";
import { resolveKeys } from "@/lib/services/workspace";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  return withAuth(req, async () => {
    const keys = await resolveKeys();
    const configured = { llm: keys.has.llm, hunter: keys.has.hunter, database: Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) };
    let hunter: { used: number | null; available: number | null } | null = null;
    try { hunter = keys.has.hunter ? await hunterAccount(keys.hunter) : null; } catch { hunter = null; }
    return Response.json({ configured, hunter });
  });
}
