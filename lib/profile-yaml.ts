import YAML from "yaml";
import { profileSchema, type Profile } from "./profile-schema";

export interface Problem { where: string; message: string }

/** Parse YAML text and validate it. Never throws. */
export function checkYaml(text: string): { spec: Profile | null; problems: Problem[] } {
  const doc = YAML.parseDocument(text, { prettyErrors: true });
  if (doc.errors.length) {
    return { spec: null, problems: doc.errors.map((e) => ({ where: e.linePos ? `line ${e.linePos[0].line}, column ${e.linePos[0].col}` : "yaml", message: e.message.split("\n")[0] })) };
  }
  const parsed = profileSchema.safeParse(doc.toJS());
  if (parsed.success) return { spec: parsed.data, problems: [] };
  return {
    spec: null,
    problems: parsed.error.issues.map((i) => {
      const node = i.path.length ? doc.getIn(i.path, true) : null;
      const range = node && typeof node === "object" && "range" in node ? (node as { range?: [number, number, number] }).range : null;
      const line = range ? text.slice(0, range[0]).split("\n").length : null;
      return { where: `${i.path.join(".") || "profile"}${line ? ` (line ${line})` : ""}`, message: i.message };
    }),
  };
}
