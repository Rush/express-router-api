import { Router, Request, Response, NextFunction, RequestParamHandler, RequestHandler, RouterOptions } from 'express';
import { PathParams, RequestHandlerParams } from 'express-serve-static-core';
import { Observable, isObservable, from, identity, defer, of, throwError, forkJoin } from 'rxjs';
import { switchMap, catchError, map } from 'rxjs/operators';

const isPromise = (val: any): val is Promise<any> => typeof val.then === 'function';

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

type SimpleApiResult = string | object | { [key: string]: string; } | undefined;

export class ApiResponse {
  constructor(public apiResult: SimpleApiResult, public code: number = 200) {}
};

type ApiResult = SimpleApiResult | ApiResponse;
type AsyncApiResult = Observable<ApiResult> | Promise<ApiResult>;

type ErrorFormatter = (err: Error, req: Request, res: Response) => AsyncApiResult | ApiResult;
type SuccessFormatter = (data: ApiResult, req: Request, res: Response) => AsyncApiResult | ApiResult;

interface ApiRouterOptions extends RouterOptions {
  errorFormatter?: ErrorFormatter;
  successFormatter?: SuccessFormatter;
  silenceExpressApiRouterError?: boolean;
  internalServerError?: string;
};

function resolve<T>(value: T | Promise<T> | Observable<T>): Observable<T> {
  if (isObservable(value)) {
    return value;
  }
  if (isPromise(value)) {
    return from(value);
  }
  return of(value);
}

const promiseProps = (obj:{ [key: string]: string; }) => {
  return forkJoin(Object.keys(obj).map(key => {
    return resolve(obj[key]).pipe(map(val => {
      return { [key]: val  };
    }));
  })).pipe(map(results => Object.assign({}, ...results)));
};

function sendApiResponse(res: Response, apiResponse: ApiResponse) {
  if(apiResponse.apiResult instanceof ApiResponse) {
    apiResponse = apiResponse.apiResult;
  }
  res.status(apiResponse.code);
  if(typeof apiResponse.apiResult === 'object') {
    return res.json(apiResponse.apiResult);
  }
  else if(typeof apiResponse.apiResult === 'string') {
    return res.send(apiResponse.apiResult);
  }
  else {
    return res.end();
  }
}

function toMiddleware(this: ExpressApiRouter, origHandler: any, options: ApiRouterOptions = {}) {
  const internalServerError = options.internalServerError || {error: 'Internal server error'};

  const processApiError = (err: ApiError, req: Request, res: Response) => {
    return defer(() => resolve(this.errorFormatter(err, req, res)))
            .pipe(map(formatted => formatted ? new ApiResponse(formatted)
              : new ApiResponse(err.message, err.statusCode || 500)
            ));
  }

  return (req: Request, res: Response, next: NextFunction) => {
    const formatterOperator = switchMap((data: ApiResult) => resolve(this.successFormatter(data, req, res)));

    const formatError = (err: Error): AsyncApiResult => {
      if (this.errorFormatter) {
        return defer(() => resolve(this.errorFormatter(err, req, res)))
          .pipe(map(formatted => new ApiResponse(formatted, 500)));
      }
      return of(undefined);
    };

    const isPlainObject = (obj: ApiResult) => (typeof obj === 'object' && !(obj instanceof ApiResponse));
    const subscription = defer(() => resolve(origHandler(req, res)))
      .pipe(
        switchMap((obj: ApiResult) => { 
          return isPlainObject(obj) ? promiseProps(obj as { [key: string]: any }) : resolve(obj);
        }),
        this.successFormatter ? formatterOperator : identity,
        switchMap(data => {
          if (data instanceof ApiError) {
            return processApiError(data, req, res);
          }
          else if (!(data instanceof ApiResponse)) {
            return of(new ApiResponse(data, 200));
          }
          return of(data);
        }),
        catchError((err: Error) => {
          if (err instanceof ExpressApiRouterError) {
            res.emit('expressApiRouterError', err);
            if(!options.silenceExpressApiRouterError) {
              console.error(err.stack);
            }
            return of(undefined);
          }
          else if (err instanceof ApiError) {
            return processApiError(err, req, res);
          }

          return throwError(err);
        }),
        catchError((err: Error) => {
          return resolve(formatError(err)).pipe(map(jsonError => {
            return new ApiResponse(jsonError || internalServerError, 500);
          }));
        }),
        catchError((err: Error) => {
          return of(new ApiResponse(internalServerError, 500));
        }),
      )
      .subscribe((apiResponse: ApiResponse | undefined) => {
        if (!apiResponse) {
          return;
        }
        sendApiResponse(res, apiResponse);
      });
    req.on('close', () => subscription.unsubscribe())
  };
}

function toParam(this: ExpressApiRouter, paramResolver: any, options: ApiRouterOptions): RequestParamHandler {
  return (req: Request, res: Response, next: NextFunction, value: any) => {
    defer(() => resolve(paramResolver(req, res, value)))
      .pipe(catchError((err: Error) => {
        if (err instanceof ExpressApiRouterError) {
          res.emit('expressApiRouterError', err);
          if(!options.silenceExpressApiRouterError) {
            console.error(err.stack);
          }
          return of(undefined);
        }
        else if (err instanceof ApiError) {
          return of(new ApiResponse(err.message, err.statusCode || 500));
        }

        return throwError(err);
      }))
      .pipe(catchError((err: Error) => {
        next(err);
        return throwError(err);
      }))
      .subscribe((value) => {
        if (value instanceof ApiResponse) {
          sendApiResponse(res, value);
          return;
        }
        next();
      });
  }
}

type MethodName =  'get' | 'post' | 'put' | 'head' | 'delete' |
  'options' | 'trace' | 'copy' | 'lock' |'mkcol' | 'move' |'purge' |
  'propfind' | 'proppatch' | 'unlock' | 'report' | 'mkactivity' | 
  'checkout' | 'merge' | 'm-search' | 'notify' | 'subscribe' |
  'unsubscribe' | 'patch' | 'search' | 'connect';
const methods: MethodName[] = [ 'get', 'post', 'put', 'head', 'delete',
  'options', 'trace', 'copy', 'lock','mkcol', 'move','purge',
  'propfind', 'proppatch', 'unlock', 'report', 'mkactivity', 
  'checkout', 'merge', 'm-search', 'notify', 'subscribe',
  'unsubscribe', 'patch', 'search', 'connect' ];

export interface ExpressApiRouter extends Router {
  errorFormatter: ErrorFormatter,
  successFormatter: SuccessFormatter,
  setErrorFormatter(formatter: ErrorFormatter): void;
  setSuccessFormatter(formatter: SuccessFormatter): void;
}

type ParamHandler = (name: string, matcher: RegExp) => RequestParamHandler;

const defaultErrorFormatter: ErrorFormatter = (err) => of(undefined);
const defaultSuccessFormatter: SuccessFormatter = (data) => of(data);

export function ExpressApiRouter(options?: ApiRouterOptions) {
  const router = Router(options);
  const apiRouter: ExpressApiRouter = Object.assign(router, {
    errorFormatter: defaultErrorFormatter,
    successFormatter: defaultSuccessFormatter,
    setErrorFormatter(formatter: ErrorFormatter) {
      this.errorFormatter = formatter;
    },
    setSuccessFormatter(formatter: SuccessFormatter) {
      this.successFormatter = formatter;
    },
  });

  methods.forEach((method: MethodName) => {
    let oldImplementation = apiRouter[method];
    apiRouter[method] = function(path: PathParams, ...callbacks: (RequestHandler | RequestHandlerParams)[]) {
      callbacks = callbacks.map((origHandler: any, index: number) => {
        // return orig handler if it provides a callback
        if(origHandler.length >= 3) {
          return origHandler;
        }
        return toMiddleware.call(apiRouter, origHandler, options);
      });
      oldImplementation.call(apiRouter, path, ...callbacks);
      return apiRouter;
    };
  });
  const oldParam = apiRouter.param;
  apiRouter.param = (nameOrCallback: (string | ParamHandler), handler?: RequestParamHandler) => {
    if (typeof nameOrCallback === 'string') {
      oldParam.call(apiRouter, nameOrCallback, toParam.call(apiRouter, handler, options));
    } else {
      throw new Error('Deprecated usage since Express 4.11');
    }
    return apiRouter;
  };

  return apiRouter;
}
