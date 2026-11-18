import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { profileSchema, type Profile } from "./profile-schema";

const DIR = path.join(process.cwd(), "config", "profiles");

export function listProfileIds(): string[] {
  return fs.readdirSync(DIR).filter((f) => f.endsWith(".yaml")).map((f) => f.replace(/\.yaml$/, ""));
}

export function loadProfile(id: string): Profile {
  if (!/^[a-z0-9-]+$/.test(id)) throw new Error("Invalid profile id");
  const raw = fs.readFileSync(path.join(DIR, `${id}.yaml`), "utf8");
  return profileSchema.parse(YAML.parse(raw));
}

export function loadOverrides(): Record<string, { name: string; email: string; title: string; linkedin?: string }> {
  try {
    return JSON.parse(fs.readFileSync(path.join(process.cwd(), "config", "poc_overrides.json"), "utf8"));
  } catch {
    return {};
  }
}
