import request from "request";

export interface HTTPRequest {
  method: "GET" | "POST";
  url: string;
  headers: { [name: string]: string };
  body: string;
}

export class HTTPBadStatusError extends Error {
  constructor(status: number, body: string) {
    super();
    this.message = `Bad HTTP status of ${status}: ${body}`;
  }
}

export default function http(req: HTTPRequest): Promise<request.Response> {
  return new Promise((resolve, reject) => {
    request(Object.assign({}, req, {
      timeout: 120000, // 2 minutes
    }), (err: any, res: request.Response) => {
      if (err) {
        reject(err);
      } else if (res.statusCode < 200 || res.statusCode > 299) {
        reject(new HTTPBadStatusError(res.statusCode, res.body));
      } else {
        resolve(res);
      }
    });
  });
}
