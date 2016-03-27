'use strict';

let express = require('express');
let methods = require('methods');
let Promise = require('bluebird');
require('promise-resolve-deep')(Promise);

class ExpressApiRouterError extends Error {
  constructor(message) {
    super(message);
    this.message = message;
    this.name = 'ExpressApiRouterError';
  }
}

class ApiError extends Error {
  constructor(data, statusCode) {
    super(data);
    this.message = data;
    this.statusCode = statusCode;
    this.name = 'ApiError';
  }
}

class ExpressApiRouter extends express.Router {
  constructor(_options) {
    super(_options);
    let options = this.options = _options || {};
    let self = this;
    
    let silenceExpressApiRouterError = this.options.silenceExpressApiRouterError;

    this.setErrorFormatter = formatter => {
      this.options.errorFormatter = formatter;
    };

    this.setSuccessFormatter = formatter => {
      this.options.successFormatter = formatter;
    };
    
    let handleErrors = (promiseChain, req, res) => {
      let apiErrorHandler = err => {
        res.status(err.statusCode || 500).json(err.message);
        return Promise.resolve();
      };
      
      promiseChain
      .catch(ExpressApiRouterError, err => {
        res.emit('expressApiRouterError', err);
        if(!silenceExpressApiRouterError) {
          console.error(err.stack);
        }
      })
      .catch(ApiError, apiErrorHandler)
      .catch(err => {
        let formatError = err => {
          if(this.options.errorFormatter) {
            return Promise.resolve().then(() => this.options.errorFormatter(err, req, res));
          }
          return Promise.resolve();
        };
        
        return formatError(err).then(jsonError => {
          res.status(500).json(jsonError || this.options.internalServerError
              || {error: 'Internal server error'});
          if(!jsonError) { // rethrow only not-formatted errors
            throw err;
          }
        })
        // support re-thrown ApiError from error formatter
        .catch(ApiError, apiErrorHandler);
      });
    };
    
    let oldImplementation = this.param;
    this.param = function(name, cb) {
      oldImplementation.call(this, name, (req, res, next, value) => {
        let promiseChain = Promise.resolve()
        .then(() => cb(req, res, value))
        .then(next);
        handleErrors(promiseChain, req, res);
      });
    };
    
    methods.forEach(method => {
      let oldImplementation = this[method];
      this[method] = function(path) {
        let callbacks = Array.prototype.slice.call(arguments, 1);
        
        callbacks = callbacks.map((origHandler, index) => {
          return (req, res, next) => {
            let promiseChain = Promise.resolve().then(() => origHandler(req, res, next))
            .tap((returnValue) => {
              if(typeof returnValue === 'undefined' && index === callbacks.length - 1) {
                throw new ExpressApiRouterError('Warning: Route for ' + path.toString() + ' did not return a promise - this happens when normal route handler is attached to express-router-api. Everything most likely works but you are advised to return API data through a promise.');
              }
            })
            .then(Promise.resolveDeep)
            .then(this.options.successFormatter ? (data => this.options.successFormatter(data, req, res) ) : (data => data))
            .then(value => {
              if(res._header) {
                throw new ExpressApiRouterError('Route for ' + path.toString() + ' returned a promise but headers were already sent by the time it was resolved');
              }
              
              if(typeof value === 'object') {
                return res.json(value);
              }
              if(typeof value === 'string') {
                return res.send(value);
              }
            });
            handleErrors(promiseChain, req, res);
          };
        });
        oldImplementation.apply(this, [path].concat(callbacks));
      };
    });
  }
};

module.exports = ExpressApiRouter;
module.exports.ApiError = ApiError;
