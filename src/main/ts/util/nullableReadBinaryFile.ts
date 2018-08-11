import * as fs from "fs";

export default function nullableReadBinaryFile(file: string): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    fs.readFile(file, (err, buffer) => {
      if (err && err.code === "ENOENT") {
        resolve(null);
      } else if (err) {
        reject(err);
      } else {
        resolve(buffer);
      }
    });
  });
}
