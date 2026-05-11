require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { testAllConnections } = require('./src/config/database');
const { startSyncScheduler } = require('./src/schedulers/syncScheduler');
const syncRoutes = require('./src/routes/sync.routes');
const log = require('./src/utils/logger');

const app = express();
const PORT = process.env.PORT || 3031;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Routes
app.get('/', (req, res) => {
  res.json({
    message: 'Welcome to SyncDB Service - MySQL to PostgreSQL Sync',
    status: 'running',
    service: 'One-way data synchronization',
    timestamp: new Date().toISOString()
  });
});

app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

// API Routes
app.use('/api/sync', syncRoutes);

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    error: 'Not Found',
    message: 'The requested resource was not found'
  });
});

// Error handler
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({
    error: 'Internal Server Error',
    message: process.env.NODE_ENV === 'development' ? err.message : 'Something went wrong'
  });
});

// Initialize and start server
const startServer = async () => {
  try {
    // Test database connections
    const dbConnected = await testAllConnections();
    
    if (!dbConnected) {
      log.error('Failed to connect to databases. Please check your configuration.');
      process.exit(1);
    }
    
    // Start sync scheduler
    startSyncScheduler();
    
    // Start Express server
    app.listen(PORT, () => {
      console.log('\n╔══════════════════════════════════════════╗');
      console.log('║      SyncDB Service Started              ║');
      console.log('╚══════════════════════════════════════════╝');
      console.log(`🚀 Server running on port: ${PORT}`);
      console.log(`📝 Environment: ${process.env.NODE_ENV || 'development'}`);
      console.log(`🔗 URL: http://localhost:${PORT}`);
      console.log(`🔄 Sync interval: ${process.env.SYNC_INTERVAL_MINUTES || 2} minutes`);
      console.log('╚══════════════════════════════════════════╝\n');
    });
    
  } catch (error) {
    log.error('Failed to start server', error);
    process.exit(1);
  }
};

// Handle graceful shutdown
process.on('SIGTERM', () => {
  log.info('SIGTERM signal received: closing HTTP server');
  process.exit(0);
});

process.on('SIGINT', () => {
  log.info('SIGINT signal received: closing HTTP server');
  process.exit(0);
});

// Start the application
startServer();

module.exports = app;
