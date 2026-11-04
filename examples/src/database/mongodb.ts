export interface IMongoCollection<T = any> {
    findOne(query: Partial<T>): Promise<T | null>;
    insertOne(doc: T): Promise<{ insertedId: string }>;
    updateOne(query: Partial<T>, update: { $set?: Partial<T> }): Promise<{ matchedCount: number; modifiedCount: number }>;
    find(query?: Partial<T>): Promise<T[]>;
    deleteMany(query: Partial<T>): Promise<{ deletedCount: number }>;
}

export interface IMongoClient {
    collection<T = any>(name: string): IMongoCollection<T>;
    close(): Promise<void>;
    isConnected(): boolean;
}

export class InMemoryMongoCollection<T extends Record<string, any>> implements IMongoCollection<T> {
    private documents: T[] = [];

    async findOne(query: Partial<T>): Promise<T | null> {
        const item = this.documents.find(doc => this.matches(doc, query));
        return item ? JSON.parse(JSON.stringify(item)) : null;
    }

    async insertOne(doc: T): Promise<{ insertedId: string }> {
        const cloned = JSON.parse(JSON.stringify(doc));
        if (!cloned._id) {
            cloned._id = 'mongo_' + Math.random().toString(36).substring(2, 9);
        }
        this.documents.push(cloned);
        return { insertedId: cloned._id };
    }

    async updateOne(query: Partial<T>, update: { $set?: Partial<T> }): Promise<{ matchedCount: number; modifiedCount: number }> {
        const index = this.documents.findIndex(doc => this.matches(doc, query));
        if (index === -1) {
            return { matchedCount: 0, modifiedCount: 0 };
        }
        if (update.$set) {
            this.documents[index] = { ...this.documents[index], ...update.$set };
        }
        return { matchedCount: 1, modifiedCount: 1 };
    }

    async find(query?: Partial<T>): Promise<T[]> {
        if (!query || Object.keys(query).length === 0) {
            return JSON.parse(JSON.stringify(this.documents));
        }
        return JSON.parse(JSON.stringify(this.documents.filter(doc => this.matches(doc, query))));
    }

    async deleteMany(query: Partial<T>): Promise<{ deletedCount: number }> {
        const initialLen = this.documents.length;
        this.documents = this.documents.filter(doc => !this.matches(doc, query));
        return { deletedCount: initialLen - this.documents.length };
    }

    private matches(doc: T, query: Partial<T>): boolean {
        for (const [k, v] of Object.entries(query)) {
            if (doc[k] !== v) return false;
        }
        return true;
    }
}

export class InMemoryMongoClient implements IMongoClient {
    private collections = new Map<string, InMemoryMongoCollection<any>>();

    collection<T = any>(name: string): IMongoCollection<T> {
        let col = this.collections.get(name);
        if (!col) {
            col = new InMemoryMongoCollection<any>();
            this.collections.set(name, col);
        }
        return col;
    }

    async close(): Promise<void> {
        this.collections.clear();
    }

    isConnected(): boolean {
        return true;
    }
}

export class LiveMongoCollection<T extends Record<string, any>> implements IMongoCollection<T> {
    private col: any;

    constructor(col: any) {
        this.col = col;
    }

    async findOne(query: Partial<T>): Promise<T | null> {
        return this.col.findOne(query);
    }

    async insertOne(doc: T): Promise<{ insertedId: string }> {
        const res = await this.col.insertOne(doc);
        return { insertedId: String(res.insertedId) };
    }

    async updateOne(query: Partial<T>, update: { $set?: Partial<T> }): Promise<{ matchedCount: number; modifiedCount: number }> {
        const res = await this.col.updateOne(query, update);
        return { matchedCount: res.matchedCount, modifiedCount: res.modifiedCount };
    }

    async find(query?: Partial<T>): Promise<T[]> {
        return this.col.find(query || {}).toArray();
    }

    async deleteMany(query: Partial<T>): Promise<{ deletedCount: number }> {
        const res = await this.col.deleteMany(query);
        return { deletedCount: res.deletedCount };
    }
}

export class LiveMongoClient implements IMongoClient {
    private client: any;
    private db: any;

    constructor(client: any, dbName = 'siglo_db') {
        this.client = client;
        this.db = client.db(dbName);
    }

    collection<T = any>(name: string): IMongoCollection<T> {
        return new LiveMongoCollection<any>(this.db.collection(name));
    }

    async close(): Promise<void> {
        await this.client.close();
    }

    isConnected(): boolean {
        return true;
    }
}

/**
 * Factory to create MongoDB client.
 * Connects to live MongoDB if MONGODB_URI is provided, or uses in-memory adapter.
 */
export function createMongoClient(uri = process.env.MONGODB_URI): IMongoClient {
    if (uri) {
        try {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { MongoClient } = require('mongodb');
            const client = new MongoClient(uri, { serverSelectionTimeoutMS: 3000 });
            console.log(`[MongoDB] Connected to live MongoDB instance at: ${uri}`);
            return new LiveMongoClient(client);
        } catch {
            console.warn('[MongoDB] mongodb driver failed to initialize. Falling back to in-memory adapter.');
            return new InMemoryMongoClient();
        }
    }

    console.log('[MongoDB] Running in-memory MongoDB adapter (zero-daemon ready)');
    return new InMemoryMongoClient();
}
