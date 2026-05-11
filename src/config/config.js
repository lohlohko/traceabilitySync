// Application configuration
const config = {
  port: process.env.PORT || 3000,
  env: process.env.NODE_ENV || 'development',
  
  // Database config (example)
  database: {
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || 5432,
    name: process.env.DB_NAME || 'traceabilityReport',
    user: process.env.DB_USER || '',
    password: process.env.DB_PASSWORD || ''
  },

  // CORS config
  cors: {
    origin: process.env.CORS_ORIGIN || '*',
    credentials: true
  }
};

module.exports = config;
