import mongoose from 'mongoose';

/**
 * Single shared MongoDB connection for the whole process, reused by every
 * Mongo-backed store this module registers. Safe to call connectMongo()
 * more than once (e.g. from tests or tsx's watch-mode reloads) — it's a
 * no-op once already connected/connecting.
 */
let connectPromise: Promise<typeof mongoose> | null = null;

export async function connectMongo(uri: string): Promise<typeof mongoose> {
  if (mongoose.connection.readyState === 1) return mongoose; // already connected
  if (!connectPromise) {
    connectPromise = mongoose
      .connect(uri, {
        maxPoolSize: 10,
        serverSelectionTimeoutMS: 8_000,
      })
      .catch((err) => {
        connectPromise = null; // allow a retry on next call instead of caching a rejected promise
        throw err;
      });
  }
  return connectPromise;
}

export function isMongoConnected(): boolean {
  return mongoose.connection.readyState === 1;
}

export async function disconnectMongo(): Promise<void> {
  await mongoose.disconnect();
  connectPromise = null;
}
