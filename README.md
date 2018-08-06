# swagger-smoke
Automatic Swagger Sanity Tests

This library might be helpful for testing Swagger powered rest APIs.
Idea is to scaffold Swagger file and get information about all endpoints, run API and run automatic tests against that API.

All path, query and body payloads are faked by default, and there is an option to supply different middlewares that will provide actual params or payload parts.
There is an option to provide security middleware as well.

Example:

```javascript
const autoSanity = require('swagger-smoke');
const swaggerApp = require('./app'); // your Swagger Express Application

const options = {
  swaggerFilePath: './src/api/swagger.yaml',
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

Project is in very early phase, there are many unsupported cases. Here is list of TODO:
- support different security types
- use not just a first security definition
- test not only a first content type
- test not only a success scenario
- add input params validation
- support multiple params mapping in a single path
