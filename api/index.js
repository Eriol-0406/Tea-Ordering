// Vercel serverless entry point.
//
// Vercel imports this module and hands it each request. server.js exports the
// configured Express app without binding a port, so the same code runs both
// here and as a normal server via `npm start`.
module.exports = require('../server.js');
