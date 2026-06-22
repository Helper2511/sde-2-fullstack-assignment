import type { Response, NextFunction, RequestHandler } from 'express';
import type { AuthedRequest } from '../auth/middleware';

/**
 * Wrap an async Express handler so a rejected promise is forwarded to the error
 * middleware. Express 4 does not await handlers, so an unwrapped `async` route
 * that throws becomes an unhandled rejection and the client hangs with no
 * response. `.catch(next)` routes the error to the central handler in index.ts.
 */
export function asyncHandler(
  fn: (req: AuthedRequest, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    fn(req as AuthedRequest, res, next).catch(next);
  };
}
