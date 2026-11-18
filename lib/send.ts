function env(name: string): string {
  const v = process.env[name];
  if (!v) throw Object.assign(new Error(`missing_env_${name}`), { permanent: true });
  return v;
}

/** The ONLY place a recipient is decided. No caller can pass one in. */
export function recipient(): string {
  return env("SEND_TO");
}

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
const b64url = (s: string) => Buffer.from(s, "utf8").toString("base64url");

export function buildMime(subject: string, body: string): string {
  const lines = [
    `To: ${recipient()}`,
    `Subject: =?UTF-8?B?${b64(subject)}?=`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    b64(body).replace(/(.{76})/g, "$1\r\n"),
  ];
  return lines.join("\r\n");
}

async function accessToken(): Promise<string> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env("GOOGLE_CLIENT_ID"),
      client_secret: env("GOOGLE_CLIENT_SECRET"),
      refresh_token: env("GOOGLE_REFRESH_TOKEN"),
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) {
    const j = (await res.json().catch(() => ({}))) as { error?: string };
    throw Object.assign(new Error(`google_token_${j.error ?? res.status}`), { permanent: res.status >= 400 && res.status < 500 });
  }
  return ((await res.json()) as { access_token: string }).access_token;
}

export async function checkGoogleAuth(): Promise<void> {
  await accessToken();
}

export async function sendTestEmail(subject: string, body: string): Promise<{ ok: boolean; message: string }> {
  let token: string;
  try {
    token = await accessToken();
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
  const raw = b64url(buildMime(subject, body));
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ raw }),
      });
      if (res.ok) return { ok: true, message: "sent" };
      if (res.status === 429 || res.status >= 500) {
        await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
        continue;
      }
      return { ok: false, message: `gmail_${res.status}` };
    } catch {
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
  return { ok: false, message: "gmail_unavailable" };
}

export function reviewBlock(info: {
  intended: string; title: string; company: string; tier: number | null; confidence: number;
  score: number | null; outcome: string; flags: string[]; why: string;
}): string {
  return [
    "REVIEW BLOCK (test mode, this was NOT sent to the prospect)",
    `Would go to: ${info.intended} (${info.title}, ${info.company})`,
    `Tier ${info.tier ?? "n/a"}, contact confidence ${info.confidence}, rank score ${info.score ?? "n/a"}`,
    `Outcome: ${info.outcome}${info.flags.length ? ` | flags: ${info.flags.join(", ")}` : ""}`,
    `Why it qualified: ${info.why}`,
    "-----------------------------------------------",
    "",
  ].join("\n");
}
