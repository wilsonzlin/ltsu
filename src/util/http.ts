import fs from "fs";
import request, {Response} from "request";
import {assertExists} from "../util/assert";

export type HTTPRequestMethod = "HEAD" | "GET" | "POST" | "PUT" | "DELETE";
export type HTTPRequestQueryParameterValue = boolean | string | number;
export type HTTPRequestQueryParameters = { [query: string]: HTTPRequestQueryParameterValue };
export type HTTPRequestHeaders = { [header: string]: string | number };

// Connections to services can frequently slow down due to load, congestion, maintenance,
// degradation, shaping, issues, etc.
// We don't want a part upload to abort halfway without a good reason as it might be a
// large part.
const HTTP_REQUEST_TIMEOUT = 120000; // 2 minutes.

export interface HTTPRequest {
  method: HTTPRequestMethod;
  url: string;
  headers: HTTPRequestHeaders;
  body?: string | fs.ReadStream | Buffer;
}

export class HTTPBadStatusError extends Error {
  readonly statusCode: number;

  constructor (status: number, body: any, url: string) {
    super(`${url} returned bad HTTP status of ${status} with body: ${body}`);
    this.statusCode = status;
  }
}

export const getLastHeaderValue = (res: Response, name: string): string => {
  const val = assertExists(res.headers[name.toLowerCase()]);
  if (Array.isArray(val)) {
    return val[val.length - 1];
  }
  return val;
};

export const http = (
  {
    method,
    url,
    headers,
    body,
  }: HTTPRequest
): Promise<request.Response> => {
  return new Promise((resolve, reject) => {
    request({
      url,
      method,
      headers,
      body,
      timeout: HTTP_REQUEST_TIMEOUT,
    }, (err, res) => {
      if (err) {
        reject(err);
      } else if (res.statusCode < 200 || res.statusCode > 299) {
        reject(new HTTPBadStatusError(res.statusCode, res.body, url));
      } else {
        resolve(res);
      }
    });
  });
};
