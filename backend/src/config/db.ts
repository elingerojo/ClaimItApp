import pg from 'pg';
import dotenv from 'dotenv';

// Ensure environment variables are loaded
dotenv.config();

// Construct the configuration object using your individual variables
const pool = new pg.Pool({
  user: process.env.DATABASE_USERNAME,
  host: process.env.DATABASE_HOST,
  database: process.env.DATABASE_NAME,
  password: process.env.DATABASE_PASSWORD,
  port: process.env.DATABASE_PORT ? parseInt(process.env.DATABASE_PORT, 10) : 5432,
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false,
  max: 20, // Max concurrent connections in backend pool
  idleTimeoutMillis: 30000,
  // Neon puede estar autosuspendido ("siesta") y tardar varios segundos en
  // aceptar la primera conexión tras un cold start. Con 2s el rehidratado de
  // arranque fallaba y el feed quedaba vacío. El pool conecta de forma perezosa
  // (solo ante una query real), así que subir el timeout NO mantiene Neon
  // despierto: solo da margen a la primera conexión en frío.
  connectionTimeoutMillis: 10000,
});

export const query = (text: string, params?: any[]) => {
  return pool.query(text, params);
};

export default pool;
