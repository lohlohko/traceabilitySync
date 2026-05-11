const formatDate = (date = new Date()) => {
  // Format timezone Indonesia (WIB - UTC+7)
  const options = {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    timeZone: 'Asia/Jakarta'
  };
  
  const formatter = new Intl.DateTimeFormat('id-ID', options);
  const parts = formatter.formatToParts(date);
  
  const dateParts = {};
  parts.forEach(({ type, value }) => {
    dateParts[type] = value;
  });
  
  return `${dateParts.year}-${dateParts.month}-${dateParts.day} ${dateParts.hour}:${dateParts.minute}:${dateParts.second}`;
};

const log = {
  info: (message, data = null) => {
    const timestamp = formatDate();
    console.log(`[${timestamp}] ℹ️  ${message}`);
    if (data) console.log(data);
  },

  success: (message, data = null) => {
    const timestamp = formatDate();
    console.log(`[${timestamp}] ✅ ${message}`);
    if (data) console.log(data);
  },

  error: (message, error = null) => {
    const timestamp = formatDate();
    console.error(`[${timestamp}] ❌ ${message}`);
    if (error) {
      console.error('Error details:', error.message || error);
      if (process.env.NODE_ENV === 'development' && error.stack) {
        console.error(error.stack);
      }
    }
  },

  warn: (message, data = null) => {
    const timestamp = formatDate();
    console.warn(`[${timestamp}] ⚠️  ${message}`);
    if (data) console.warn(data);
  },

  sync: (message, data = null) => {
    const timestamp = formatDate();
    console.log(`[${timestamp}] 🔄 ${message}`);
    if (data) console.log(data);
  }
};

module.exports = log;
