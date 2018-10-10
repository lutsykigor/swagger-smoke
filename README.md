# swagger-smoke
Semi-automated Swagger API Sanity Tests

This library might be helpful for testing Swagger powered rest APIs.
Idea is to scaffold Swagger file and get information about all endpoints, run API and run automatic tests against that API basing on Swagger metadata.

All path, query and body payloads are faked by default, and there is an option to supply different middlewares that will provide actual parameter values or payload parts.

There is an option to provide security middlewares as well.

The number of tests equals number of endpoints multiplied by number of responses defined for these endpoints in Swagger.
If some middleware parameters or security token values should be cached, it is responsibility of library users to cache them. This library will call middleware everytime it needs to get parameter or security header value.

Example:

```javascript
const autoSanity = require('swagger-smoke');
const swaggerApp = require('./app'); // your Swagger Express Application

const options = {
  swaggerFilePath: './src/api/swagger.yaml', //app relative path to Swagger file
  setParamsInBody: true, // whether we need to use real parameters in request fake payloads
  bodyFakeOptions: { // this options are passed directly to 'json-schema-faker' which is used for fakes
    alwaysFakeOptionals: true
  }
};

const testApp = autoSanity(options);

// oauth token support
testApp.security('token_auth', async (metadata) => {
  return `Bearer ${await <userTokenPromise>}`;
});

// static params support, if options.setParamsInBody is enabled, this params values will be used in fake request payloads
testApp.params({
  swaggerParamName: 'value',
  queryParamName: 'value',
  bodyParamName: 'value'
});

//dynamic async param, when param value depends on some async operation
testApp.params('paramName', async () => {
  const response = await testHelper.createObjectInDB();
  return response.data.id;
});

validator.runTests(swaggerApp).then(result => console.log(JSON.stringify(result)))
```

## Middlewares
### Parameters
To provide specific values for parameters used in path, query or body, `params` method should be used. If single object is passed to that method, every field of that object is treated as a separate parameter and is used at tests runtime:

```javascript
testApp.params({
  userId: 'value',
  length: 'value'
});
```

These params are static and will be used for all fieds that have corresponding names in all tests.

To provide parameter values that have asyncronous nature or provide different parameter values depends on endpoint path, method or response status code, overloaded `params` method should be used.

First parameter is a endpoint path name as defined in Swagger, second is a callback function that will be called to get actual security headers value. Callback is invoked with 3 parameters (`path`, `method`, `responseDefinitionName`) at a runtime.

Examples:
```javascript
// syncronous get from DB
testApp.params('paramName', () => {
  const response = testHelper.createObjectInDB();
  return response.data.id;
});

// asyncronous get from DB
testApp.params('paramName', async () => {
  const response = await testHelper.createObjectInDB();
  return response.data.id;
});

// asyncronous depends on path or method or swagger response definition
testApp.params('userId', async (path, method, responseDefinitionName) => {
	if (path === '/users/{userId}'
	&& (method === 'delete' || method === 'patch')
	&& (swaggerResponseDefinition === 200)) {
		let user = await testHelper.createUser();
		return user.id;
	}
	return testHelper.testUser().id;
});
```

### Security
To profide security headers values `security` method should be used, first parameter is a name of security definition as defined in Swagger, second is a callback function that will be called to get actual security headers value, which is called with 4 parameters (`swaggerSecurityDefinition`, `path`, `method`, `responseDefinitionName`) at a runtime. If handler returns string value it will be set to `Authorization` header. If handler returns object, its keys would be treated as separate headers and will be added to request payload. Example:
```javascript
// authorization header token
validator.security('token_auth', async () => {
	let accessToken = await testHelper.newAccessToken();
	return `Bearer ${accessToken}`;
});

// authorization header conditional
validator.security('token_auth', async (metadata, path, method, responseDefinitionName) => {
    if (path === '/profile') {
		if (method === 'put') {
		    let user = await testHelper.createUser('user');
			let accessToken = await testHelper.newAccessToken();
			return `Bearer ${accessToken}`;
		}
		if (method === 'patch') {
			let user = await testHelper.createUser('new-user');
			let accessToken = await testHelper.newAccessToken(user);
			return `Bearer ${accessToken}`;
		}
	}

	if (responseDefinitionName === 401) {
	    return `Bearer <expiredToken>`;
	}

	let accessToken = await testHelper.newAccessToken();
	return `Bearer ${accessToken}`;
});

// authorization multiple headers
validator.security('custom_auth', async () => {
    return {
        Authorization: 'Basic ...',
        X-Custom-Auth: '...'
    };
});
```

## Options
Library accepts `options` object for tests flow customization, available options:

| Option Name  | Type | Description |
| ---| --- | --- |
| bodyFakeOptions | Object | [json-schema-faker](https://github.com/json-schema-faker/json-schema-faker#custom-options) custom options for faking payloads, example: ```{ alwaysFakeOptionals: true, failOnInvalidFormat: false }``` |
| disable | Array<string> | List of endpoints that should be skipped, example `['get:/user/info']` |
| forceAuthorizationHeader  | boolean | Adds security headers to every request even if security is not specified at Swagger endpoint level, uses first security definition that was provided  |
| notRequiredPropertiesValidation | boolean | True to force validating all not required fields
| setParamsInBody | boolean | True to use params middlewares in body payload |
| swaggerFilePath  | string | Relative path to Swagger file, from app perspective  |
| successHttpCode | integer | Default HTTP status code that is used if one is not provided in Swagger method definition, if not provided `200` is used |
| zSchema | Object | [z-schema](https://github.com/zaggino/z-schema#options) custom options for faking payloads, example: ```{ ignoreUnknownFormats: true }``` |

## Misc
Project is in early phase, there are many unsupported cases. Here is list of TODO:
- test different content types
- add input params validation
- add support for plugins
