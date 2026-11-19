// Admin scripts act as the service role inside one workspace. Find it by name, then enter it with enterCtx(serviceCtx(id)).
import { serviceDb } from "../lib/db";

export async function workspaceByName(name = "Default workspace"): Promise<string> {
  const found = await serviceDb().from("workspaces").select("id").eq("name", name).order("created_at").limit(1);
  const id = (found.data?.[0] as { id: string } | undefined)?.id;
  if (id) return id;
  const made = await serviceDb().from("workspaces").insert({ name }).select("id").single();
  if (made.error) throw new Error(`could not create workspace ${name}`);
  return (made.data as { id: string }).id;
}
