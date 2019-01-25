import crypto from "crypto";

export type HTTPRequestMethod = "GET" | "POST";
export type HTTPRequestQueryArguments = { [query: string]: string };
export type HTTPRequestHeaders = { [header: string]: string };

function percentEncodeBytes(str: string | number, encodeSlashes: boolean = true): string {
  if (typeof str === "number") {
    return `${str}`;
  }

  let encoded = [];
  for (let i = 0; i < str.length; i++) {
    let char = str[i];
    if ((char >= "A" && char <= "Z") || (char >= "a" && char <= "z") || (char >= "0" && char <= "9") || char ===
      "_" || char === "-" || char === "~" || char === ".") {
      encoded.push(char);
    } else if (char === "/") {
      encoded.push(encodeSlashes ? "%2F" : char);
    } else {
      encoded.push("%" + char.charCodeAt(0).toString(16).toLocaleUpperCase());
    }
  }
  return encoded.join("");
}

function hashSHA256(data: Buffer | string): Buffer {
  return crypto.createHash("sha256").update(data).digest();
}

function hmac({ secret, data }: { secret: Buffer | string; data: Buffer | string; }): Buffer {
  return crypto.createHmac("sha256", secret).update(data).digest();
}

interface CanonicalRequest {
  hash: string;
  headers: string;
}

function generateCanonicalRequest(httpRequest: {
  method: HTTPRequestMethod;
  host: string;
  path: string;
  args?: HTTPRequestQueryArguments | null;
  headers?: HTTPRequestHeaders | null;
  body?: string | null;
  payloadHash?: string | null;
}): CanonicalRequest {
  let method = httpRequest.method;
  let host = httpRequest.host;
  let path = httpRequest.path;
  let queryArgs = httpRequest.args;
  let headers = httpRequest.headers;
  let body = httpRequest.body;
  let payloadHash = httpRequest.payloadHash;

  let canonicalRequest = [
    method,
    percentEncodeBytes(path, false),
  ];

  if (!queryArgs) {
    canonicalRequest.push("");
  } else {
    let queryParams = [];
    let encodedParamsMap: { [query: string]: boolean | string | number } = {};

    for (let k of Object.keys(queryArgs)) {
      let v = queryArgs[k];
      let kencoded = percentEncodeBytes(k);
      encodedParamsMap[kencoded] = v;
      queryParams.push(kencoded);
    }
    queryParams.sort();

    let queryAWSEncoded = [];

    for (let k of queryParams) {
      let v = encodedParamsMap[k];
      let vType = typeof v;
      if (v === true) {
        queryAWSEncoded.push(k + "=");
      } else if (v === false) {
        // skip
      } else if (vType !== "string" && vType !== "number") {
        throw { message: "Unrecognised query arg value type: " + vType, code: 267 };
      } else {
        queryAWSEncoded.push(k + "=" + percentEncodeBytes(v));
      }
    }

    canonicalRequest.push(queryAWSEncoded.join("&"));
  }

  let headerNames = ["host"];
  let headersLCMap: HTTPRequestHeaders = { host: host };
  if (headers) {
    for (let name of Object.keys(headers)) {
      let value = headers[name];
      let lc = name.toLocaleLowerCase();
      headerNames.push(lc);
      headersLCMap[lc] = value;
    }
    headerNames.sort();
  }
  let signedHeaders = headerNames.join(";");

  for (let name of headerNames) {
    canonicalRequest.push(name + ":" + headersLCMap[name]);
  }

  canonicalRequest.push("");
  canonicalRequest.push(signedHeaders);

  let contentSha256;
  if (payloadHash) {
    contentSha256 = payloadHash;
  } else if (headers) {
    for (let headerName of Object.keys(headers)) {
      let headerValue = headers[headerName];
      if (headerName.toLocaleLowerCase() === "x-amz-content-sha256") {
        contentSha256 = headerValue;
        break;
      }
    }
  }
  if (!contentSha256) {
    contentSha256 = hashSHA256(body || "").toString("hex");
  }

  canonicalRequest.push(contentSha256);

  return {
    hash: hashSHA256(canonicalRequest.join("\n")).toString("hex"),
    headers: signedHeaders,
  };
}

function deriveSigningKey(values: {
  secretAccessKey: string;
  region: string;
  service: string;
  isoDate: string;
}): Buffer {
  let secretAccessKey = values.secretAccessKey;
  let region = values.region;
  let service = values.service;
  let isoDate = values.isoDate;

  let dateKey = hmac({ secret: "AWS4" + secretAccessKey, data: isoDate });
  let dateRegionKey = hmac({ secret: dateKey, data: region });
  let dateRegionServiceKey = hmac({ secret: dateRegionKey, data: service });
  return hmac({ secret: dateRegionServiceKey, data: "aws4_request" });
}

function sign(derivedKey: Buffer | string, stringToSign: Buffer | string): string {
  return hmac({ data: stringToSign, secret: derivedKey }).toString("hex");
}

export interface AWSSignature {
  isoDateTime: string;
  method: HTTPRequestMethod;
  host: string;
  path: string;
  args: HTTPRequestQueryArguments | null;
  headers: HTTPRequestHeaders | null;
  body?: string | null;
  payloadHash?: string | null;
  service: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export function createAuthHeader(signatureValues: AWSSignature) {
  let isoDate = signatureValues.isoDateTime.slice(0, 8);

  let { hash: canonicalRequest, headers: signedHeadersJoined } = generateCanonicalRequest({
    method: signatureValues.method,
    host: signatureValues.host,
    path: signatureValues.path,
    args: signatureValues.args,
    headers: signatureValues.headers,
    body: signatureValues.body,
  });

  let stringToSign = [
    "AWS4-HMAC-SHA256",
    signatureValues.isoDateTime,
    [isoDate, signatureValues.region, signatureValues.service, "aws4_request"].join("/"),
    canonicalRequest,
  ].join("\n");

  let derivedKey = deriveSigningKey({
    secretAccessKey: signatureValues.secretAccessKey,
    region: signatureValues.region,
    service: signatureValues.service,
    isoDate: isoDate,
  });

  let signature = sign(derivedKey, stringToSign);

  return `AWS4-HMAC-SHA256 Credential=${signatureValues.accessKeyId}/${isoDate}/${signatureValues.region}/${signatureValues.service}/aws4_request, SignedHeaders=${signedHeadersJoined}, Signature=${signature}`;
}
