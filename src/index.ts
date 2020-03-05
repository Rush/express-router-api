import {
  IRoute, NextFunction, Request, RequestHandler,
  RequestParamHandler, Response, Router, RouterOptions,
} from 'express';
import { PathParams, RequestHandlerParams } from 'express-serve-static-core';
import { defer, forkJoin, from, isObservable, Observable, of, throwError } from 'rxjs';
import { catchError, map, switchMap } from 'rxjs/operators';

const isPromise = (val: any): val is Promise<any> => (val && typeof val.then === 'function');

export class ExpressApiRouterError extends Error {
  constructor(message: string) {
    super(message);
    this.message = message;
    this.name = 'ExpressApiRouterError';

    Object.setPrototypeOf(this, ExpressApiRouter.prototype);
  }
}

export class ApiError extends Error {
  statusCode: number;

  constructor(data: string, statusCode: number) {
    super(data);
    this.message = data;
    this.statusCode = statusCode;
    this.name = 'ApiError';

    Object.setPrototypeOf(this, ApiError.prototype);
  }
}

export const ApiNext: unique symbol = Symbol('ApiNext');

type SimpleApiResult = string | boolean | number | object | { [key: string]: string; } | typeof ApiNext |  undefined;

export class ApiResponse {
  constructor(public apiResult: SimpleApiResult, public code: number = 200) {}
}

export type ApiResult = SimpleApiResult | ApiResponse;
export type AsyncApiResult = Observable<ApiResult> | Promise<ApiResult>;

export type ErrorFormatter = (this: ExpressApiRouter, err: Error, req: Request, res: Response)
  => AsyncApiResult | ApiResult;
export type SuccessFormatter = (this: ExpressApiRouter, data: ApiResult, req: Request, res: Response)
  => AsyncApiResult | ApiResult;

export interface ApiRouterOptions extends RouterOptions {
  errorFormatter?: ErrorFormatter;
  successFormatter?: SuccessFormatter;
  silenceExpressApiRouterError?: boolean;
  internalServerError?: string;
}

function resolve<T>(value: T | Promise<T> | Observable<T>): Observable<T> {
  if (isObservable(value)) {
    return value;
  }
  if (isPromise(value)) {
    return from(value);
  }
  return of(value);
}

const promiseProps = (obj: { [key: string]: string; }) => {
  const keys = Object.keys(obj);
  if (!keys.length) {
    return of(obj);
  }
  return forkJoin(Object.keys(obj).map((key) => {
    return resolve(obj[key]).pipe(map((val) => {
      return { [key]: val  };
    }));
  })).pipe(map((results) => Object.assign({}, ...results)));
};

function sendApiResponse(res: Response, apiResponse?: ApiResponse) {
  if (typeof apiResponse === 'undefined') {
    return false;
  }

  if (typeof apiResponse.apiResult === 'undefined' || apiResponse.apiResult === ApiNext) {
    return false;
  }

  if (apiResponse.apiResult instanceof ApiResponse) {
    apiResponse = apiResponse.apiResult;
  }
  res.status(apiResponse.code);
  if (typeof apiResponse.apiResult === 'object') {
    res.json(apiResponse.apiResult);
    return true;
  } else if (typeof apiResponse.apiResult === 'string') {
    res.send(apiResponse.apiResult);
    return true;
  } else {
    res.end();
    return true;
  }
}

function toMiddleware(this: ExpressApiRouter,
                      origHandler: RequestHandler,
                      options: ApiRouterOptions = {}, callNext: boolean = false) {
  const internalServerError = options.internalServerError || {error: 'Internal server error'};

  const processApiError = (err: ApiError, req: Request, res: Response) => {
    return defer(() => resolve(this.errorFormatter(err, req, res)))
            .pipe(map((formatted) => formatted ? new ApiResponse(formatted)
              : new ApiResponse(err.message, err.statusCode || 500),
            ));
  };

  return (req: Request, res: Response, next: NextFunction) => {
    const formatterOperator = switchMap((data: ApiResult) => {
      if (data === ApiNext) {
        return of(data);
      }
      return resolve(this.successFormatter(data, req, res));
    });

    const formatError = (err: Error): AsyncApiResult => {
      if (this.errorFormatter) {
        return defer(() => resolve(this.errorFormatter(err, req, res)))
          .pipe(map((formatted) => new ApiResponse(formatted, (err as any).statusCode || 500)));
      }
      return of(undefined);
    };

    const isPlainObject = (obj: ApiResult) => {
      return (typeof obj === 'object' &&
        !(obj instanceof ApiResponse) &&
        !(obj instanceof ApiError)) &&
        !(obj instanceof Array);
    };
    const subscription = defer(() => resolve(origHandler(req, res, next)))
      .pipe(
        switchMap((obj: ApiResult) => {
          return isPlainObject(obj) ? promiseProps(obj as { [key: string]: any }) : resolve(obj);
        }),
        formatterOperator,
        switchMap((data) => {
          if (data instanceof ApiError) {
            return processApiError(data, req, res);
          } else if (!(data instanceof ApiResponse)) {
            return of(new ApiResponse(data, 200));
          }
          return of(data);
        }),
        catchError((err: Error) => {
          if (err instanceof ExpressApiRouterError) {
            res.emit('expressApiRouterError', err);
            if (!options.silenceExpressApiRouterError) {
              // tslint:disable-next-line:no-console
              console.error(err.stack);
            }
            return of(undefined);
          } else if (err instanceof ApiError) {
            return processApiError(err, req, res);
          }

          return throwError(err);
        }),
        catchError((err: Error) => {
          return resolve(formatError(err)).pipe(map((jsonError) => {
            return new ApiResponse(jsonError || internalServerError, (jsonError && (jsonError as any).statusCode) || 500);
          }));
        }),
        catchError((err: Error) => {
          return of(new ApiResponse(internalServerError, (err as any).statusCode || 500));
        }),
      )
      .subscribe((apiResponse: ApiResponse | undefined) => {
        if (!sendApiResponse(res, apiResponse)) {
          if (callNext || (apiResponse && apiResponse.apiResult === ApiNext)) {
            next();
          }
        }
      });
    req.on('close', () => subscription.unsubscribe());
  };
}

type MethodName =  'get' | 'post' | 'put' | 'head' | 'delete' |
  'options' | 'trace' | 'copy' | 'lock' |'mkcol' | 'move' |'purge' |
  'propfind' | 'proppatch' | 'unlock' | 'report' | 'mkactivity' |
  'checkout' | 'merge' | 'm-search' | 'notify' | 'subscribe' |
  'unsubscribe' | 'patch' | 'search' | 'connect';
const methods: MethodName[] = [ 'get', 'post', 'put', 'head', 'delete',
  'options', 'trace', 'copy', 'lock', 'mkcol', 'move', 'purge',
  'propfind', 'proppatch', 'unlock', 'report', 'mkactivity',
  'checkout', 'merge', 'm-search', 'notify', 'subscribe',
  'unsubscribe', 'patch', 'search', 'connect' ];

export interface ExpressApiRouter extends Router {
  errorFormatter: ErrorFormatter;
  successFormatter: SuccessFormatter;
  setErrorFormatter(formatter: ErrorFormatter): void;
  setSuccessFormatter(formatter: SuccessFormatter): void;
}

type ParamHandler = (name: string, matcher: RegExp) => RequestParamHandler;

const defaultErrorFormatter: ErrorFormatter = (err) => of(undefined);
const defaultSuccessFormatter: SuccessFormatter = (data) => of(data);

function patchMethods(apiRouter: (Router), options?: ApiRouterOptions) {
  methods.forEach((method: MethodName) => {
    const oldImplementation = apiRouter[method];
    // tslint:disable-next-line:only-arrow-functions
    apiRouter[method] = function(path: PathParams, ...callbacks: (RequestHandler | RequestHandlerParams)[]) {
      callbacks = callbacks.map((origHandler: any, index: number) => {
        // return orig handler if it provides a callback
        if (origHandler.length >= 3) {
          return origHandler;
        }
        return toMiddleware.call(apiRouter as ExpressApiRouter, origHandler, options);
      });
      oldImplementation.call(apiRouter, path, ...callbacks);
      return apiRouter;
    };
  });
}

// TODO remove redundancy with patchMethods
function patchMethodsForRoute(route: IRoute, apiRouter: Router, options?: ApiRouterOptions) {
  methods.forEach((method: MethodName) => {
    const oldImplementation = (route as any)[method];
    // tslint:disable-next-line:only-arrow-functions
    (route as any)[method] = function(...callbacks: (RequestHandler | RequestHandlerParams)[]) {
      callbacks = callbacks.map((origHandler: any, index: number) => {
        // return orig handler if it provides a callback
        if (origHandler.length >= 3) {
          return origHandler;
        }
        return toMiddleware.call(apiRouter as ExpressApiRouter, origHandler, options);
      });
      oldImplementation.call(route, ...callbacks);
      return route;
    };
  });
}

export function ExpressApiRouter(options?: ApiRouterOptions) {
  const router = Router(options);

  const errorFormatter = (options && options.errorFormatter) || defaultErrorFormatter;
  const successFormatter = (options && options.successFormatter) || defaultSuccessFormatter;

  const apiRouter: ExpressApiRouter = Object.assign(router, {
    errorFormatter,
    successFormatter,
    setErrorFormatter(formatter: ErrorFormatter) {
      this.errorFormatter = formatter;
    },
    setSuccessFormatter(formatter: SuccessFormatter) {
      this.successFormatter = formatter;
    },
  });

  patchMethods(apiRouter, options);

  const oldRoute = apiRouter.route;
  apiRouter.route = (method: string) => {
    const routeObject = oldRoute.call(apiRouter, method);
    patchMethodsForRoute(routeObject as any, apiRouter, options);
    return routeObject;
  };

  const oldParam = apiRouter.param.bind(apiRouter);
  apiRouter.param = (nameOrCallback: (string | ParamHandler), handler?: RequestParamHandler) => {
    if (typeof nameOrCallback === 'string' && handler) {
      oldParam(nameOrCallback, toMiddleware.call(apiRouter, handler as RequestHandler, options, true));
    } else {
      throw new Error('Deprecated usage since Express 4.11');
    }
    return apiRouter;
  };

  return apiRouter;
}
