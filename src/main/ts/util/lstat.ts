import * as fs from "fs";

export default function lstat(file: string): Promise<fs.Stats> {
  return new Promise((resolve, reject) => {
    fs.lstat(file, (err, stats) => {
      if (err) {
        reject(err);
      } else {
        resolve(stats);
      }
    });
  });
}
