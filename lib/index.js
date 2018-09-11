'use strict';

const SwaggerParser = require('swagger-parser');
const suertest = require('supertest');
const fakeGenerator = require('json-schema-faker');
const ZSchema = require('z-schema');
const chalk = require('chalk');
const jsonPath = require('jsonpath');
const lodash = require('lodash');

const DEFAULT_SUCCESS_CODE = 200;

let _globalReject;
process.on('unhandledRejection', error => {
  if (_globalReject) {
    return _globalReject(error);
  }
  process.exit(1);
});

const contractValidator = async (options) => {
  if (!options || !options.swaggerFilePath) {
    throw new Error('swagger file path was not provided');
  }

  const apiDefinitions = await SwaggerParser.validate(options.swaggerFilePath);

  fakeGenerator.option(options.jsonSchemaFaker.options);
  fakeGenerator.format(options.jsonSchemaFaker.format);
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
    this._schemaValidator = new ZSchema(options.zSchema);
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

  async _testEndpoint(name, metadata) {
    const methods = Object.getOwnPropertyNames(metadata);
    for (const methodName of methods) {
      await this._testEndpointMethod(name, methodName, metadata[methodName]);
    }
  };

  async _testEndpointMethod(template, method, metadata) {

    if (this.options.disable
      && this.options.disable.includes(`${method}:${template}`)) {
      console.log(chalk.gray(`${method.toUpperCase()} ${template}`));
      return;
    }

    const testCases = this._getGetMethodTestCases(metadata.responses);

    for(const testCase of testCases) {
      await this._testCase(method, template, metadata, testCase);
    }
  }

  async _testCase(method, template, metadata, testCase) {
    const url = await this._buildUrl(template, method, metadata.parameters, testCase.code);
    const headers = await this._getRequestHeaders(metadata, template, method, testCase.code);
    const body = await this._buildRequestBody(template, metadata.parameters, testCase.code);
    const testName = `${method.toUpperCase()} ${template} (${testCase.code})`;

    if (this.options.disable && this.options.disable.includes(`${method}:${template}`)) {
      console.log(chalk.gray(`${method.toUpperCase()} ${template}`));
      return;
    }

    process.on('uncaughtException', _globalReject);

    return new Promise((resolve, reject) => {
      _globalReject = reject;
      this._api[method](this._basePath + url)
        .set(headers)
        .expect(testCase.code)
        .send(body)
        .then((res) => {
          if (testCase.metadata
            && testCase.metadata.schema
            && !this._schemaValidator.validate(res.body, testCase.metadata.schema)) {
            const schemaValidationErrorMessage = this._schemaValidator.lastReport.errors.length ?
              JSON.stringify(this._schemaValidator.lastReport.errors) : 'unknown schema validation error';

            console.log(chalk.red(`${testName}: ${schemaValidationErrorMessage}`));
            this._testFails++;
            return resolve();
          }

          console.log(chalk.green(`${testName}`));
          this._testPasses++;
          resolve();
        }).catch((error) => {
          console.log(chalk.red(`${testName}: ${error}`));
          this._testFails++;
          reject(error);
      });
    });
  }

  async _getRequestHeaders(metadata,
                           template,
                           method,
                           caseStatusCode) {
    let headers = {};

    headers = await this._setSecurityHeader(
      metadata.security, headers, template, method, caseStatusCode);
    headers = await this._setContentType(metadata, headers, caseStatusCode);
    return headers;
  };

  async _buildUrl(template,
                  method,
                  params,
                  testCaseStatusCode) {
    if (params) {
      for (const param of params) {
        if (param.in === 'body') {
          continue;
        }

        const paramValue = await this.getParamValue(param.name,
          param.type, testCaseStatusCode, template, method);

        if (param.in === 'path') {
          template = template.replace(`{${param.name}}`, paramValue);
          continue;
        }

        if (param.in === 'query') {
          template += `${(template.includes('?') ? '&' : '?')}${param.name}=${paramValue}`;
        }
      }
    }
    return template;
  };

  async getParamValue (key, type, statusCode, ...args) {
    if(this._requestParams.has(key)) {
      return await this._call(this._requestParams.get(key).handler, args);
    }

    if (this._staticParams && this._staticParams.hasOwnProperty(key)) {
      return this._staticParams[key];
    }

    if (type) {
      return this._generateErrorParam(type, statusCode);
    }
  };

  _generateErrorParam(type, statusCode) {
    if (type) {
      if (statusCode === 400) {
        type = ((type) => {
          switch(type) {
            case 'integer':
            case 'number':
            case 'boolean':
            case 'array':
            case 'object':
              return 'string';
            case 'string':
              return 'integer';
            default:
              return 'string';
          }
        })(type);
      }
      return fakeGenerator.resolve({type});
    }
  }

  async _buildRequestBody(template, params, testCaseStatusCode) {
    if (!params)
      return;

    const bodyParam = params.find((param) => param.in === 'body');

    if (bodyParam) {
      let fakeData = await fakeGenerator.resolve(bodyParam.schema);

      if (this.options.setParamsInBody) {
        const paramsKeys = lodash.union(
          Object.getOwnPropertyNames(this._staticParams),
          this._requestParamsKeys);

        for (const paramKey of paramsKeys) {
          fakeData = await this.setObjectParamValue(fakeData,
            paramKey, template, testCaseStatusCode);
        }
      }
      return fakeData;
    }
  };

  async setObjectParamValue(object,
                            key,
                            template,
                            testCaseStatusCode) {
    const paramMatches = jsonPath.paths(object, `$..${key}`);

    if (paramMatches.length > 0) {
      const paramValue = await this.getParamValue(key, null, testCaseStatusCode, template, true);
      paramMatches.forEach((paramMatch) => {
        // generate path and remove '$.' from its start
        const paramPath = jsonPath.stringify(paramMatch).substring(2);
        lodash.set(object, paramPath, paramValue);
      });
    }

    return object;
  };

  _setContentType(metadata,headers) {
    const [contentType] = metadata.consumes || ['application/json'];

    headers['Content-Type'] = contentType;
    return headers;
  };

  async _setSecurityHeader(securityMetadataCollection,
                           headers,
                           path,
                           method,
                           caseStatusCode) {
    if (!this._security.size) {
      return headers;
    }

    let middleware;
    let metadata = null;

    if (securityMetadataCollection
      && securityMetadataCollection.length) {
      const [securityMetadata] = securityMetadataCollection;
      const securityMiddlewareKey = this._securityKeys.find(
        (middlewareKey) => securityMetadata.hasOwnProperty(middlewareKey));

      middleware = this._security.get(securityMiddlewareKey);
      metadata = securityMetadata[securityMiddlewareKey];
    } else {
      if (!this.options.forceAuthorizationHeader) {
        return headers;
      }
      middleware = this._security.values().next().value;
    }

    const securityHeader = await this._call(middleware.handler, [metadata, path, method, caseStatusCode]);

    if (lodash.isObject(securityHeader)) {
      headers = Object.assign(headers, securityHeader);
    } else {
      if (lodash.isString(securityHeader)) {
        headers.Authorization = securityHeader;
      } else {
        throw new Error(`Security middleware returned not supported value: \
        ${JSON.stringify(securityHeader)}. Supported types: {string}, {object}.`);
      }
    }
    return headers;
  };

  _getGetMethodTestCases(responses) {
    const testCases = Object.getOwnPropertyNames(responses)
      .map((statusCode) => parseInt(statusCode))
      .filter((statusCode) => statusCode < (this.options.successCases ? 300 : 500))
      .map((statusCode) => {
        const metadata = responses[statusCode.toString()];

        if (this.options.notRequiredPropertiesValidation) {
          this._forceSchemaPropertiesAsRequired(metadata.schema);
        }

        return {
          code: statusCode,
          metadata: metadata
        };
      });


    if (testCases.length) {
      return testCases;
    }

    // adding default test case if response wasn't defined at Swagger
    return [{
      code: this.options.successHttpCode || DEFAULT_SUCCESS_CODE
    }];
  };

  _forceSchemaPropertiesAsRequired(schema) {
    if (schema && schema.properties) {
      schema.required = Object.getOwnPropertyNames(schema.properties);
    }
    lodash.forIn(schema, (val, key) => {
      if (lodash.isArray(val)) {
        val.forEach((el) => {
          if (lodash.isObject(el)) {
            this._forceSchemaPropertiesAsRequired(el);
          }
        });
      }
      if (lodash.isObject(key)) {
        this._forceSchemaPropertiesAsRequired(schema[key]);
      }
    });
  }

  async _call(fn, params) {
    const result = fn(...params);

    if (fn instanceof (async () => {}).constructor) {
      return await result;
    }

    return result;
  };
}

module.exports = contractValidator;
