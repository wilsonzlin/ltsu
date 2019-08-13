import {AWSGlacierOptions} from "./AWSGlacier";

export const parseOptions = (args: { [name: string]: string }): AWSGlacierOptions => {
  const region = args.region;
  const accessId = args.access;
  const secretKey = args.secret;
  const vaultName = args.vault;

  return {
    region, accessId, secretKey, vaultName,
  };
};
