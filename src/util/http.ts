import request from "request";
import fs from "fs";

export interface httpArguments {
  method: "HEAD" | "GET" | "POST" | "PUT" | "DELETE";
  url: string;
  headers: { [name: string]: string | number };
  body?: string | fs.ReadStream | object | null;
}

export class HTTPBadStatusError extends Error {
  readonly statusCode: number;

  constructor (status: number, body: any, url: string) {
    super(`${url} returned bad HTTP status of ${status}: ${body}`);
    this.statusCode = status;
  }
}

const isPlainObject = (o: any): o is Object => {
  if (o == null) {
    return false;
  }
  const proto = Object.getPrototypeOf(o);
  return proto == Object.prototype || proto == null;
};

export const http = <R = any> ({method, url, headers, body}: httpArguments): Promise<R> => {
  return new Promise((resolve, reject) => {
    if (isPlainObject(body)) {
      body = JSON.stringify(body);
    }
    request({
      url,
      method,
      headers,
      body,
      timeout: 120000, // 2 minutes
    }, (err, res) => {
      if (err) {
        reject(err);
      } else if (res.statusCode < 200 || res.statusCode > 299) {
        reject(new HTTPBadStatusError(res.statusCode, res.body, url));
      } else {
        const parsed = JSON.parse(res.body);
        resolve(parsed);
      }
    });
  });
};
