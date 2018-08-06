'use strict';

const SwaggerParser = require('swagger-parser');
const suertest = require('supertest');
const fakeGenerator = require('json-schema-faker');
const ZSchema = require('z-schema');
const chalk = require('chalk');
const schemaValidator = new ZSchema();
const jsonPath = require('jsonpath');
const lodash = require('lodash');

const DEFAULT_SUCCESS_CODE = 200;

const contractValidator = async (options) => {
  if (!options || !options.swaggerFilePath) {
    throw new Error('swagger file path was not provided');
  }

  const apiDefinitions = await SwaggerParser.validate(options.swaggerFilePath);

  fakeGenerator.option(options.bodyFakeOptions);
  return new SwaggerSmoke(apiDefinitions, options);
};

/**
 * Swagger API Auto Sanity Tests
 */
class SwaggerSmoke {
  /**
   * Creates Swagger Auto Sanity Tester
   * @param {Array} apiDefinitions - Swagger definitions
   * @param {Object} options - options object
   */
  constructor(apiDefinitions, options) {
    this._basePath = apiDefinitions.basePath;
    this._security = new Map();
    this._requestParams = new Map();
    this._testFails = 0;
    this._testPasses = 0;
    this._apiDefinitions = apiDefinitions;
    this.options = options;
  }

  /**
   * Run tests automatic for Swagger API
   * @param {Object} swaggerApp - Swagger express app
   * @return {Promise<{fails: number, passes: number}>}
   */
  async runTests(swaggerApp) {
    this._securityKeys = Array.from(this._security.keys());
    this._requestParamsKeys = Array.from(this._requestParams.keys());
    this._api = suertest(swaggerApp);

    const endpoints = Object.getOwnPropertyNames(this._apiDefinitions.paths);
    for (const endpointName of endpoints) {
      await this._testEndpoint(endpointName, this._apiDefinitions.paths[endpointName]);
    }

    console.log(chalk.yellow(`Passed: ${this._testPasses}, Fails: ${this._testFails}`));

    return {
      fails: this._testFails,
      passes: this._testPasses
    };
  };

  /**
   * Add security middleware
   * @param {string} key - Swagger security name
   * @param {any} handler - handler function, may be async
   */
  security(key, handler) {
    this._security.set(key, {handler, cache: {}});
  }

  /**
   * Add param definitions or middleware
   * @param {string} key - Swagger param name, if object is passed -
   * will use it as a static parameters dictionary
   * @param {any} handler - handler function, may be async
   * (optional if static params dictionary is passed)
   */
  params(key, handler) {
    if (!handler) {
      this._staticParams = key;
      return;
    }
    this._requestParams.set(key, {handler, cache: {}});
  }

  async _testEndpoint(name, metadata, options) {
    const methods = Object.getOwnPropertyNames(metadata);
    for (const methodName of methods) {
      await this._testMethod(name, methodName, metadata[methodName], options);
    }
  };

  async _testMethod(template, method, metadata, options) {
    const url = await this._buildUrl(template, metadata.parameters);
    const body = await this._buildRequestBody(template, metadata.parameters, options);
    const successResponse = this._getSuccessResponseMetadata(metadata.responses);
    const headers = await this._getRequestHeaders(metadata);

    return this._api[method](this._basePath + url)
      .set(headers)
      .expect(successResponse.code)
      .send(body)
      .then((res) => {
        if (successResponse.schema
          && !schemaValidator.validate(res.body, successResponse.schema)) {
          console.log(chalk.red(`${method.toUpperCase()} ${template}`));
          this._testFails++;
        }

        console.log(chalk.green(`${method.toUpperCase()} ${template}`));
        this._testPasses++;
      }).catch((error) => {
        console.log(chalk.red(`${method.toUpperCase()} ${template}: ${error}`));
        this._testFails++;
      });
  };

  async _getRequestHeaders(metadata) {
    let options = {};

    options = await this._setAuthorizationHeader(metadata.security, options);
    options = await this._setContentType(metadata, options);

    return options;
  };

  async _buildUrl(template, params) {
    if (params) {
      for (const param of params) {
        if (param.in === 'path') {
          template = template.replace(`{${param.name}}`,
            await this.getParamValue(param.name, template));
          continue;
        }
        if (param.in === 'query') {
          template += `${(template.includes('?') ? '&' : '?')}${param.name}=${
            await this.getParamValue(param.name, template)}`;
        }
      }
    }
    return template;
  };

  async getParamValue (key, ...args) {
    if(this._requestParams.has(key)) {
      return await this._call(this._requestParams.get(key).handler, args);
    }
    if (this._staticParams && this._staticParams.hasOwnProperty(key)) {
      return this._staticParams[key];
    }
  };

  async _buildRequestBody(template, params) {
    if (!params)
      return;

    const bodyParam = params.find((param) => param.in === 'body');

    if (bodyParam) {
      let fakeData = await fakeGenerator.resolve(bodyParam.schema);

      if (this.options.setParamsInBody) {
        for (const paramKey of this._requestParamsKeys) {
          fakeData = await this.setObjectParamValue(fakeData, paramKey, template);
        }
        for (const paramKey of Object.getOwnPropertyNames(this._staticParams)) {
          fakeData = await this.setObjectParamValue(fakeData, paramKey, template);
        }
      }
      return fakeData;
    }
  };

  async setObjectParamValue(object, key, template) {
    const paramMatches = jsonPath.paths(object, `$..${key}`);

    if (paramMatches.length > 0) {
      const paramValue = await this.getParamValue(key, template, true);
      paramMatches.forEach((paramMatch) => {
        // generate path and remove '$.' from its start
        const paramPath = jsonPath.stringify(paramMatch).substring(2);
        lodash.set(object, paramPath, paramValue);
      });
    }

    return object;
  };

  _setContentType(metadata, options) {
    const [contentType] = metadata.consumes || ['application/json'];

    options['Content-Type'] = contentType;
    return options;
  };

  async _setAuthorizationHeader(securityMetadataCollection, options) {
    if (!securityMetadataCollection
      || securityMetadataCollection.length === 0
      || !this._security.size)
      return options;

    const [securityMetadata] = securityMetadataCollection;
    const securityMiddlewareKey = this._securityKeys.find(
      (middlewareKey) => securityMetadata.hasOwnProperty(middlewareKey));
    const middleware = this._security.get(securityMiddlewareKey);

    options.Authorization = await this._call(middleware.handler,
      securityMetadata[securityMiddlewareKey]);
    return options;
  };

  _getSuccessResponseMetadata(responses) {
    const keys = Object.getOwnPropertyNames(responses);
    let code = this.options.successHttpCode || DEFAULT_SUCCESS_CODE;

    if (keys.length !== 0) {
      code = Object.getOwnPropertyNames(responses)
        .map((statusCode) => parseInt(statusCode))
        .find((statusCode) => statusCode < 300);
    }

    return {
      code: code,
      metadata: responses[code]
    };
  };

  async _call(fn, ...params) {
    if (fn instanceof (async () => {}).constructor) {
      return await fn(...params);
    }

    return fn(...params);
  };
}

module.exports = contractValidator;