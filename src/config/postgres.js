const { Pool } = require('pg');

// PostgreSQL connection pool configuration (warehouse)
const pgPool = new Pool({
  host: process.env.PG_HOST,
  port: process.env.PG_PORT || 5432,
  user: process.env.PG_USER,
  password: process.env.PG_PASSWORD,
  database: process.env.PG_DATABASE,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

// PostgreSQL connection pool configuration (transactions source)
const pgTransactionsPool = new Pool({
  host: process.env.PG_TRANSACTIONS_HOST,
  port: process.env.PG_TRANSACTIONS_PORT || 5432,
  user: process.env.PG_TRANSACTIONS_USER,
  password: process.env.PG_TRANSACTIONS_PASSWORD,
  database: process.env.PG_TRANSACTIONS_DATABASE,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

// Test connection
const testPGConnection = async () => {
  try {
    const client = await pgPool.connect();
    console.log('✅ PostgreSQL connected successfully');
    client.release();
    return true;
  } catch (error) {
    console.error('❌ PostgreSQL connection failed:', error.message);
    return false;
  }
};

// Handle pool errors
pgPool.on('error', (err) => {
  console.error('Unexpected PostgreSQL pool error:', err);
});

pgTransactionsPool.on('error', (err) => {
  console.error('Unexpected PostgreSQL transactions pool error:', err);
});

module.exports = {
  pgPool,
  pgTransactionsPool,
  testPGConnection
};
