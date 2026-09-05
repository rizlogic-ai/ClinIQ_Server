import { Router, RequestHandler, ErrorRequestHandler } from "express";

const METHODS = ["get", "post", "put", "patch", "delete", "use"] as const;

/**
 * Express 4 does not forward a rejected promise from an async handler, so a
 * single unhandled database error terminates the whole process. Every handler
 * registered here is wrapped so rejections reach the error middleware instead.
 */
export function safeRouter(): Router {
  const router = Router();
  for (const method of METHODS) {
    const original = (router as never as Record<string, (...a: unknown[]) => unknown>)[method].bind(router);
    (router as never as Record<string, (...a: unknown[]) => unknown>)[method] = (...args: unknown[]) =>
      original(...args.map((arg) => (typeof arg === "function" ? wrap(arg as RequestHandler) : arg)));
  }
  return router;
}

function wrap(fn: RequestHandler | ErrorRequestHandler): RequestHandler | ErrorRequestHandler {
  // A 4-arg handler is error middleware; leave its signature intact.
  if (fn.length === 4) return fn;
  const handler: RequestHandler = (req, res, next) => {
    try {
      Promise.resolve((fn as RequestHandler)(req, res, next)).catch(next);
    } catch (err) {
      next(err);
    }
  };
  return handler;
}
