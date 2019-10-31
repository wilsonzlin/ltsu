import crypto from "crypto";
import {HTTPRequestHeaders, HTTPRequestMethod, HTTPRequestQueryParameters} from "../util/http";

const leftPad = (str: string | number, width: number, char: string = "0"): string => {
  str = `${str}`;
  return char.repeat(Math.max(0, width - str.length)) + str;
};

export const getISOTime = (): string => {
  let d = new Date();
  return [
    leftPad(d.getUTCFullYear(), 4),
    leftPad(d.getUTCMonth() + 1, 2),
    leftPad(d.getUTCDate(), 2),
    `T`,
    leftPad(d.getUTCHours(), 2),
    leftPad(d.getUTCMinutes(), 2),
    leftPad(d.getUTCSeconds(), 2),
    `Z`
  ].join("");
};

const percentEncodeBytes = (str: string | number, encodeSlashes: boolean = true): string => {
  if (typeof str === "number") {
    return `${str}`;
  }

  const encoded = [];
  for (let i = 0; i < str.length; i++) {
    const char = str[i];
    if ((char >= "A" && char <= "Z")
      || (char >= "a" && char <= "z")
      || (char >= "0" && char <= "9")
      || char === "_"
      || char === "-"
      || char === "~"
      || char === "."
    ) {
      encoded.push(char);
    } else if (char === "/") {
      encoded.push(encodeSlashes ? "%2F" : char);
    } else {
      encoded.push("%" + char.charCodeAt(0).toString(16).toLocaleUpperCase());
    }
  }
  return encoded.join("");
};

const hashSHA256 = (data: Buffer | string): Buffer => crypto.createHash("sha256").update(data).digest();

const hmac = (
  {
    secret,
    data,
  }: {
    secret: Buffer | string;
    data: Buffer | string;
  }
): Buffer =>
  crypto.createHmac("sha256", secret).update(data).digest();

interface CanonicalRequest {
  hash: string;
  headers: string;
}

const generateCanonicalRequest = (
  {
    method,
    host,
    path,
    queryParameters,
    headers,
    contentSHA256,
  }: {
    method: HTTPRequestMethod;
    host: string;
    path: string;
    queryParameters?: HTTPRequestQueryParameters;
    headers?: HTTPRequestHeaders;
    contentSHA256: string;
  }
): CanonicalRequest => {
  const canonicalRequest = [
    method,
    percentEncodeBytes(path, false),
  ];

  if (!queryParameters) {
    canonicalRequest.push("");
  } else {
    const paramsEncodedNames: string[] = [];
    const paramsEncodedMap: HTTPRequestQueryParameters = {};

    for (const [name, value] of Object.entries(queryParameters)) {
      const encodedName = percentEncodeBytes(name);
      paramsEncodedMap[encodedName] = value;
      paramsEncodedNames.push(encodedName);
    }
    paramsEncodedNames.sort();

    const queryAWSEncoded = [];

    for (const name of paramsEncodedNames) {
      const value = paramsEncodedMap[name];
      if (value === true) {
        queryAWSEncoded.push(`${name}=`);
      } else if (value === false) {
        // skip
      } else {
        queryAWSEncoded.push(`${name}=${percentEncodeBytes(value)}`);
      }
    }

    canonicalRequest.push(queryAWSEncoded.join("&"));
  }

  const headerNames = ["host"];
  const headersLCMap: HTTPRequestHeaders = {host};
  if (headers) {
    for (const [name, value] of Object.entries(headers)) {
      const lowerCaseName = name.toLocaleLowerCase();
      headerNames.push(lowerCaseName);
      headersLCMap[lowerCaseName] = value;
    }
    headerNames.sort();
  }
  const signedHeaders = headerNames.join(";");

  for (const name of headerNames) {
    canonicalRequest.push(`${name}:${headersLCMap[name]}`);
  }

  canonicalRequest.push("");
  canonicalRequest.push(signedHeaders);

  canonicalRequest.push(contentSHA256);

  return {
    hash: hashSHA256(canonicalRequest.join("\n")).toString("hex"),
    headers: signedHeaders,
  };
};

function deriveSigningKey (
  {
    secretAccessKey,
    region,
    service,
    isoDate,
  }: {
    secretAccessKey: string;
    region: string;
    service: string;
    isoDate: string;
  }
): Buffer {
  const dateKey = hmac({secret: `AWS4${secretAccessKey}`, data: isoDate});
  const dateRegionKey = hmac({secret: dateKey, data: region});
  const dateRegionServiceKey = hmac({secret: dateRegionKey, data: service});
  return hmac({secret: dateRegionServiceKey, data: "aws4_request"});
}

function sign (derivedKey: Buffer | string, stringToSign: Buffer | string): string {
  return hmac({data: stringToSign, secret: derivedKey}).toString("hex");
}

export interface AWSSignature {
  isoDateTime: string;
  method: HTTPRequestMethod;
  host: string;
  path: string;
  queryParameters?: HTTPRequestQueryParameters;
  headers?: HTTPRequestHeaders;
  contentSHA256: string;
  service: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export const createAuthHeader = (
  {
    isoDateTime,
    method,
    host,
    path,
    queryParameters,
    headers,
    contentSHA256,
    service,
    region,
    accessKeyId,
    secretAccessKey,
  }: AWSSignature
): string => {
  const isoDate = isoDateTime.slice(0, 8);

  const {hash: canonicalRequest, headers: signedHeadersJoined} = generateCanonicalRequest({
    method,
    host,
    path,
    queryParameters,
    headers,
    contentSHA256,
  });

  const stringToSign = [
    "AWS4-HMAC-SHA256",
    isoDateTime,
    [isoDate, region, service, "aws4_request"].join("/"),
    canonicalRequest,
  ].join("\n");

  const derivedKey = deriveSigningKey({
    secretAccessKey: secretAccessKey,
    region: region,
    service: service,
    isoDate: isoDate,
  });

  const signature = sign(derivedKey, stringToSign);

  return `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${isoDate}/${region}/${service}/aws4_request, SignedHeaders=${signedHeadersJoined}, Signature=${signature}`;
};
