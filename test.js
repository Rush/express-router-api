'use strict';

require('chai');
const express = require('express');
const rp = require('request-promise');
const { Router } = require('express');
require('ts-node/register');
const { ExpressApiRouter, ApiError, ApiResponse, ApiNext } = require('./src');
const {expect, assert} = require('chai');
const Promise = require('bluebird');
const { of } = require('rxjs');

const checkFor = (val) => {
  return val2 => {
    assert.deepEqual(val2, val);
  };
};

let port = 44441;

describe('ExpressApiRouter', function() {
  let app, router, server;

  function routeTest() {
    const args = Array.prototype.slice.call(arguments);
    router.get('/foo', ...args);
    router.route('/fooRoute').get(...args);
  }

  function paramTest() {
    const args =  Array.prototype.slice.call(arguments);
    const paramHandler = args.pop();
    router.get.apply(router, ['/foo/:param'].concat(args));
    router.param('param', paramHandler);
  }

  function requestTest(data, statusCode, extra) {
    const url = `http://localhost:${port}/foo${extra||''}`;
    return rp(url).then(data => {
      if (data[0] === '[' || data[0] === '{') {
        return JSON.parse(data);
      }
      return data;
    }).catch(err => {
      if (err.statusCode != (statusCode || 500)) {
        throw new Error(`Status code should equal ${statusCode || 500}, was ${err.statusCode}`);
      }
      return JSON.parse(err.error);
    }).then(checkFor(data));
  }

  beforeEach(cb => {
    app = express();
    router = new ExpressApiRouter({
      silenceExpressApiRouterError: true
    });
    app.use('/', router);

    server = app.listen(port, () => {cb()});
  })
  afterEach(cb => {
    server.close(cb);
  });

  it('should support old style usage', async () => {
    routeTest((req, res) => {
      res.send('test');
    });

    return requestTest('test');
  });

  it('should support embedded promise', () => {
    routeTest((req, res) => {
      return {
        foo: Promise.delay(10).then(() => 'bar')
      };
    });

    return requestTest({
      foo: 'bar'
    });
  });

  it('should support observables', () => {
    routeTest((req, res) => {
      return of({foo: 'bar'});
    });

    return requestTest({
      foo: 'bar'
    });
  });

  it('should support embedded observables', () => {
    routeTest((req, res) => {
      return {foo: of('bar') };
    });

    return requestTest({
      foo: 'bar'
    });
  });

  it('should support plain object', () => {
    routeTest((req, res) => {
      return {
        foo: 'bar'
      };
    });

    return requestTest({
      foo: 'bar'
    });
  });

  it('should support plain object with success formatter', () => {
    router.setSuccessFormatter(result => {
      return {test: result}
    });

    routeTest((req, res) => {
      return {
        foo: 'bar'
      };
    });

    return requestTest({test: {
      foo: 'bar'
    }});
  });

  it('should support direct promise', () => {
    routeTest((req, res) => {
      return Promise.resolve({
        foo: 'bar'
      });
    });

    return requestTest({
      foo: 'bar'
    });
  });

  it('should support reporting JSON errors', () => {
    routeTest((req, res) => {
      throw new ApiError({error: 'test'}, 403);
    });

    return requestTest({
      error: 'test'
    }, 403);
  });

  it('should support reporting JSON errors from promise', () => {
    routeTest((req, res) => {
      return Promise.delay(10).then(() => {
        throw new ApiError({error: 'test'}, 403);
      });
    });

    return requestTest({
      error: 'test'
    }, 403)
  });

  it('should support custom error formatter', () => {
    router.setErrorFormatter(err => {
      return {data: err.message};
    });

    routeTest((req, res) => {
      return Promise.delay(10).then(() => {
        throw new Error('foo');
      });
    });

    return requestTest({
      data: 'foo'
    }, 500)
  });

  it('should support custom error formatter for formatting ApiError', () => {
    router.setErrorFormatter(err => {
      return {data: err.message};
    });

    routeTest((req, res) => {
      return Promise.delay(10).then(() => {
        throw new ApiError('foo', 200);
      });
    });

    return requestTest({
      data: 'foo'
    }, 500)

  });

  it('should report internal server error when error formatter fails', () => {
    router.setErrorFormatter(err => {
      throw new ApiError({message: err.message}, 403);
    });

    routeTest((req, res) => {
      return Promise.delay(10).then(() => {
        throw new Error('foo');
      });
    });

    return requestTest({
      error: 'Internal server error'
    }, 500)
  });

  it('should support regular middleware', () => {
    routeTest((req, res, next) => {
      req.data = 'abc';
      next();
    }, (req, res) => {
      return {foo: req.data}
    });

    return requestTest({
      foo: 'abc'
    })
  });

  it('should support handling promise-based middleware', () => {
    routeTest((req) => {
      req.data = 'def';
      return ApiNext;
    }, (req, res) => {
      return {foo: req.data}
    });

    return requestTest({
      foo: 'def'
    })
  });

  it('should support param handler', () => {
    paramTest((req, res) => {
      return req.paramData;
    }, (req, res, param) => {
      return Promise.delay(20).then(() => {
        req.paramData = {foo: req.params.param};
      });
    });

    return requestTest({
      foo: 'xxx'
    }, 200, '/xxx');
  });

  it('should support reporting JSON errors from promise when thrown from param handler', () => {
    paramTest((req, res) => {}, (req, res, param) => {
      return Promise.delay(10).then(() => {
        throw new ApiError({error: 'test'}, 403);
      });
    });

    return requestTest({
      error: 'test'
    }, 403, '/xxx');
  });

  it('should allow sending a custom response', () => {
    paramTest((req, res) => {}, (req, res, param) => {
      return Promise.delay(10).then(() => {
        return new ApiResponse({customResponse: 'test'}, );
      });
    });

    return requestTest({
      customResponse: 'test'
    }, 418, '/xxx');
  });

  it('should support returning ApiError as a value', () => {
    routeTest((req, res) => {
      return Promise.delay(10).then(() => {
        return new ApiError({error: 'test'}, 403);
      });
    });

    return requestTest({
      error: 'test'
    }, 403);
  });


  it('returning undefined should not send a response', async () => {
    routeTest((req, res) => {
      return Promise.delay(10).then(() => {
        return undefined;
      });
    });

    let timedOut = false;
    await requestTest('', 500).timeout(50).catch(Promise.TimeoutError, () => {
      timedOut = true;
    });
    expect(timedOut).to.equal(true);
  });

  it('should handle arrays from async value', () => {
    routeTest((req, res) => {
      return Promise.resolve(['aa']);
    });

    return requestTest(['aa']);
  });

  it('should handle direct arrays', () => {
    routeTest((req, res) => {
      return ['aa'];
    });

    return requestTest(['aa']);
  });

  it('should handle empty arrays from async function', () => {
    routeTest(async (req, res) => {
      return [];
    });

    return requestTest([]);
  });

  it('should handle empty arrays', () => {
    routeTest((req, res) => {
      return [];
    });

    return requestTest([]);
  });

  it('should handle empty objects from async function', () => {
    routeTest(async (req, res) => {
      return {};
    });

    return requestTest({});
  });

  it('should support plain object with registered .route', () => {
    routeTest((req, res) => {
      return {
        foo: 'bar'
      };
    });

    return requestTest({
      foo: 'bar'
    }, 200, 'Route');
  });

  it('should support plain object with registered .route and success formatter', () => {
    router.setSuccessFormatter(result => {
      return {test: result}
    });

    routeTest((req, res) => {
      return {
        foo: 'bar'
      };
    });

    return requestTest({
      test: { foo: 'bar' }
    }, 200, 'Route');
  });
});
