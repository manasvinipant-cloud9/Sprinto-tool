import { timingSafeEqual } from "node:crypto";

export function checkAuth(req: Request): Response | null {
  const expected = process.env.APP_PASSWORD;
  if (!expected) return Response.json({ error: "Server is not configured (APP_PASSWORD missing)." }, { status: 500 });
  const got = req.headers.get("x-app-password") ?? "";
  const a = Buffer.from(got);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return Response.json({ error: "Wrong or missing password." }, { status: 401 });
  return null;
}
