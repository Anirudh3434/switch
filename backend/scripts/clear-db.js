import { MongoClient } from 'mongodb';

const uri = process.env.MONGODB_URI || 'mongodb://localhost:27017';
const dbName = process.env.MONGODB_DB || 'switch';

console.log(`Connecting to MongoDB at ${uri} (db: ${dbName})...`);

const client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000 });

try {
  await client.connect();
  const db = client.db(dbName);
  const collections = ['users', 'sessions', 'refresh', 'shares', 'devices', 'feedbacks', 'otps', 'recoveryKeys'];

  console.log('Clearing collections...');
  for (const name of collections) {
    const res = await db.collection(name).deleteMany({});
    console.log(`  ✓ ${name}: deleted ${res.deletedCount} documents`);
  }

  console.log('\nVerification (current document counts):');
  for (const name of collections) {
    const count = await db.collection(name).countDocuments();
    console.log(`  - ${name}: ${count}`);
  }

  console.log('\nDatabase cleared successfully.');
} catch (err) {
  console.error('Error clearing database:', err);
  process.exit(1);
} finally {
  await client.close();
}
