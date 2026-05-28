require('dotenv').config();

const isProduction = process.env.NODE_ENV === 'production';

const parseAllowedOrigins = () => {
  const raw = process.env.CORS_ALLOWED_ORIGINS || '';
  return raw
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
};

const allowedOrigins = parseAllowedOrigins();
const allowAllOrigins = allowedOrigins.includes('*') || (!isProduction && allowedOrigins.length === 0);

const corsOptions = {
  origin: function (origin, callback) {
    if (!origin) {
      return callback(null, true);
    }

    if (allowAllOrigins || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }

    return callback(new Error(`CORS blocked for origin: ${origin}`));
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type', 
    'Authorization', 
    'X-Requested-With',
    'Tus-Resumable',
    'Upload-Length',
    'Upload-Metadata',
    'Upload-Offset',
    'Upload-Concat',
    'Upload-Defer-Length'
  ],
  exposedHeaders: [
    'Tus-Resumable',
    'Upload-Length',
    'Upload-Metadata',
    'Upload-Offset',
    'Upload-Concat',
    'Location'
  ],
  credentials: true,
  optionsSuccessStatus: 200,
  preflightContinue: false
};

module.exports = corsOptions;
