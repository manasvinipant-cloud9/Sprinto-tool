import type { DomainResult } from "./types";

/** "priya.rao@acme.com" becomes "p***@acme.com". Used so a public demo never shows real people's email addresses. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at < 1) return "***";
  return `${email[0]}***${email.slice(at)}`;
}

/** A copy of a result with every person's email address masked. */
export function maskResult(r: DomainResult): DomainResult {
  return {
    ...r,
    contact: r.contact ? { ...r.contact, email: maskEmail(r.contact.email) } : null,
    candidates: r.candidates.map((c) => ({ ...c, email: maskEmail(c.email) })),
  };
}
