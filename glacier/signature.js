"use strict";

const crypto = require("crypto");

class Utils {
  static percentEncodeBytes (str, encodeSlashes = true) {
    if (typeof str === "number") {
      return str;
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

  static hashSHA256 (data) {
    return crypto.createHash("sha256").update(data).digest();
  }

  static hmac ({secret, data}) {
    return crypto.createHmac("sha256", secret).update(data).digest();
  }
}

function generateCanonicalRequest (httpRequest) {
  let method = httpRequest.method;
  let host = httpRequest.host;
  let path = httpRequest.path;
  let queryArgs = httpRequest.args; // Can be nil
  let headers = httpRequest.headers; // Can be nil
  let body = httpRequest.body; // Can be nil
  let payloadHash = httpRequest.payloadHash; // Can be nil

  if (!method || !host || !path) {
    throw {message: "Missing arguments", code: 97};
  }

  let canonicalRequest = [
    method,
    Utils.percentEncodeBytes(path, false),
  ];

  if (!queryArgs) {
    canonicalRequest.push("");
  } else {
    let queryParams = {};
    let encodedParamsMap = {};

    for (let k of Object.keys(queryArgs)) {
      let v = queryArgs[k];
      let kencoded = Utils.percentEncodeBytes(k);
      encodedParamsMap[kencoded] = v;
      queryParams.push(kencoded);
    }
    queryParams.sort();

    let queryAWSEncoded = {};

    for (_ of Object.keys(queryParams)) {
      let k = queryParams[_];
      let v = encodedParamsMap[k];
      let vType = type(v);
      if (v === true) {
        queryAWSEncoded.push(k + "=");
      } else if (v === false) {
        // skip
      } else if (vType !== "string" && vType !== "number") {
        throw {message: "Unrecognised query arg value type: " + vType, code: 267};
      } else {
        queryAWSEncoded.push(k + "=" + Utils.percentEncodeBytes(v));
      }
    }

    canonicalRequest.push(queryAWSEncoded.join("&"));
  }

  let headerNames = ["host"];
  let headersLCMap = {host: host};
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
    contentSha256 = Utils.hashSHA256(body || "").toString("hex");
  }

  canonicalRequest.push(contentSha256);

  return [
    Utils.hashSHA256(canonicalRequest.join("\n")).toString("hex"),
    signedHeaders
  ];
}

function deriveSigningKey (values) {
  let secretAccessKey = values.secretAccessKey;
  let region = values.region;
  let service = values.service;
  let isoDate = values.isoDate;

  if (!secretAccessKey || !region || !service || !isoDate) {
    throw {message: "Missing arguments", code: 95};
  }

  let dateKey = Utils.hmac({secret: "AWS4" + secretAccessKey, data: isoDate});
  let dateRegionKey = Utils.hmac({secret: dateKey, data: region});
  let dateRegionServiceKey = Utils.hmac({secret: dateRegionKey, data: service});
  let signingKey = Utils.hmac({secret: dateRegionServiceKey, data: "aws4_request"});

  return signingKey;
}

function sign (derivedKey, stringToSign) {
  return Utils.hmac({data: stringToSign, secret: derivedKey}).toString("hex");
}

class Signature {
  constructor (httpRequest) {
    let isoDateTime = httpRequest.isoDateTime; // Required, will not be auto generated
    let expires = httpRequest.expires; // Can be nil
    let method = httpRequest.method;
    let host = httpRequest.host;
    let path = httpRequest.path;
    let queryArgs = httpRequest.args; // Can be nil
    let headers = httpRequest.headers; // Can be nil
    let body = httpRequest.body; // Can be nil
    let payloadHash = httpRequest.payloadHash; // Can be nil
    let service = httpRequest.service;
    let region = httpRequest.region;
    let accessKeyId = httpRequest.accessKeyId;
    let secretAccessKey = httpRequest.secretAccessKey;

    if (!isoDateTime || !method || !host || !path || !service || !region || !accessKeyId || !secretAccessKey) {
      throw {message: "Missing arguments", code: 96};
    }

    let isoDate = isoDateTime.slice(0, 8);

    this.isoDateTime = isoDateTime;
    this.isoDate = isoDate;
    this.expires = expires;
    this.method = method;
    this.host = host;
    this.path = path;
    this.args = queryArgs;
    this.headers = headers;
    this.body = body;
    this.payloadHash = payloadHash;
    this.service = service;
    this.region = region;
    this.accessKeyId = accessKeyId;
    this.secretAccessKey = secretAccessKey;
  }

  toAuthHeader () {
    let [canonicalRequest, signedHeadersJoined] = generateCanonicalRequest({
      method: this.method,
      host: this.host,
      path: this.path,
      args: this.args,
      headers: this.headers,
      body: this.body,
    });

    let stringToSign = [
      "AWS4-HMAC-SHA256",
      this.isoDateTime,
      [this.isoDate, this.region, this.service, "aws4_request"].join("/"),
      canonicalRequest,
    ].join("\n");

    let derivedKey = deriveSigningKey({
      secretAccessKey: this.secretAccessKey,
      region: this.region,
      service: this.service,
      isoDate: this.isoDate,
    });

    let signature = sign(derivedKey, stringToSign);

    let headerValue = `AWS4-HMAC-SHA256 Credential=${this.accessKeyId}/${this.isoDate}/${this.region}/${this.service}/aws4_request, SignedHeaders=${signedHeadersJoined}, Signature=${signature}`;

    return headerValue;
  }
}

module.exports = Signature;
