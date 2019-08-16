import {promises as fs} from "fs";

export function nullableReadFile (path: string): Promise<Buffer | null>;
export function nullableReadFile (path: string, encoding: string): Promise<string | null>;
export async function nullableReadFile (path: string, encoding?: string): Promise<Buffer | string | null> {
  try {
    return await fs.readFile(path, encoding);
  } catch (err) {
    if (err.code == "ENOENT") {
      return null;
    }
    throw err;
  }
}

export async function nullableReadJson<T> (path: string): Promise<T | null> {
  const raw = await nullableReadFile(path, "utf8");
  return raw != null ? JSON.parse(raw) : null;
}
