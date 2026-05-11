const { testMySQLConnection } = require('./mysql');
const { testPGConnection } = require('./postgres');

const testAllConnections = async () => {
  console.log('\n🔍 Testing database connections...\n');
  
  const mysqlOk = await testMySQLConnection();
  const pgOk = await testPGConnection();
  
  if (mysqlOk && pgOk) {
    console.log('\n✅ All database connections successful\n');
    return true;
  } else {
    console.log('\n❌ Some database connections failed\n');
    return false;
  }
};

module.exports = {
  testAllConnections
};
