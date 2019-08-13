import crypto from "crypto";

export const computeFinalChecksum = (treeHashes: Buffer[]): Buffer => {
  while (treeHashes.length > 1) {
    const newHashes = [];
    for (let i = 0; i < treeHashes.length - 1; i += 2) {
      newHashes.push(crypto.createHash("sha256").update(
        Buffer.concat(treeHashes.slice(i, i + 2))
      ).digest());
    }
    if (treeHashes.length % 2 === 1) {
      newHashes.push(treeHashes[treeHashes.length - 1]);
    }
    treeHashes = newHashes;
  }
  return treeHashes[0];
};
