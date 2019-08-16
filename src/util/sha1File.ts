import fs from "fs";
import crypto from "crypto";

export const sha1File = (stream: fs.ReadStream): Promise<Buffer> => {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash(`sha1`);
    stream.on("error", err => reject(err));
    stream.on("data", chunk => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest()));
  });
};
