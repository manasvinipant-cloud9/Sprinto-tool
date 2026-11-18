import { checkAuth } from "@/lib/auth";
import { hunterAccount } from "@/lib/poc";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const denied = checkAuth(req);
  if (denied) return denied;
  const configured = {
    llm: Boolean((process.env.LLM_PROVIDER || "gemini") === "anthropic" ? process.env.ANTHROPIC_API_KEY : process.env.GEMINI_API_KEY),
    hunter: Boolean(process.env.HUNTER_API_KEY),
    gmail: Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_REFRESH_TOKEN),
    send_to: Boolean(process.env.SEND_TO),
  };
  let hunter: { used: number | null; available: number | null } | null = null;
  try {
    hunter = await hunterAccount();
  } catch {
    hunter = null;
  }
  return Response.json({ configured, hunter });
}
