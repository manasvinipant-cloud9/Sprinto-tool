import { createHash } from "node:crypto";
import type { Profile } from "./profile-schema";

export function profileHash(p: Profile): string {
  return createHash("sha256").update(JSON.stringify(p)).digest("hex").slice(0, 12);
}
