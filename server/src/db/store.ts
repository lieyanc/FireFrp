import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../utils/logger';

export interface StoreOptions<T> {
  filePath: string;
  defaults?: T[];
}

export class JsonStore<T extends { id: number }> {
  private items: T[] = [];
  private nextId: number = 1;
  private readonly filePath: string;

  constructor(private readonly options: StoreOptions<T>) {
    this.filePath = path.resolve(options.filePath);
  }

  /**
   * Load data from the JSON file, or initialize with defaults if the file does not exist.
   * Sets file permissions to 0600 (owner read/write only) for security.
   */
  load(): void {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      logger.info({ dir }, 'Created data directory');
    }

    if (fs.existsSync(this.filePath)) {
      try {
        const raw = fs.readFileSync(this.filePath, 'utf-8');
        this.items = JSON.parse(raw) as T[];
        // Ensure file has restrictive permissions
        try { fs.chmodSync(this.filePath, 0o600); } catch { /* ignore on platforms that don't support chmod */ }
        logger.info({ file: this.filePath, count: this.items.length }, 'Store loaded');
      } catch (err) {
        logger.error({ err, file: this.filePath }, 'Failed to parse store file, starting with defaults');
        this.items = this.options.defaults ? [...this.options.defaults] : [];
      }
    } else {
      this.items = this.options.defaults ? [...this.options.defaults] : [];
      this.save();
      logger.info({ file: this.filePath }, 'Store file created with defaults');
    }

    // Compute nextId from existing items
    this.nextId = this.items.length > 0
      ? Math.max(...this.items.map((item) => item.id)) + 1
      : 1;
  }

  /**
   * Atomic write: write to a tmp file then rename to the target path.
   * File permissions are set to 0600 (owner read/write only) to protect sensitive data.
   */
  save(): void {
    const tmpPath = this.filePath + '.tmp';
    try {
      fs.writeFileSync(tmpPath, JSON.stringify(this.items, null, 2), { encoding: 'utf-8', mode: 0o600 });
      fs.renameSync(tmpPath, this.filePath);
    } catch (err) {
      logger.error({ err, file: this.filePath }, 'Failed to save store');
      // Clean up tmp file if rename failed
      try {
        if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
      } catch {
        // ignore cleanup errors
      }
      throw err;
    }
  }

  /**
   * Insert a new item. The id field is auto-generated.
   */
  insert(item: Omit<T, 'id'>): T {
    const newItem = { ...item, id: this.nextId++ } as T;
    this.items.push(newItem);
    this.save();
    return newItem;
  }

  /**
   * Update an item by id with a partial patch. Returns the updated item or null if not found.
   */
  update(id: number, patch: Partial<T>): T | null {
    const index = this.items.findIndex((item) => item.id === id);
    if (index === -1) return null;
    this.items[index] = { ...this.items[index], ...patch, id } as T;
    this.save();
    return this.items[index];
  }

  /**
   * Delete an item by id. Returns true if the item was found and deleted.
   */
  delete(id: number): boolean {
    const index = this.items.findIndex((item) => item.id === id);
    if (index === -1) return false;
    this.items.splice(index, 1);
    this.save();
    return true;
  }

  /**
   * Find a single item by id.
   */
  findById(id: number): T | undefined {
    return this.items.find((item) => item.id === id);
  }

  /**
   * Find the first item where `field` equals `value`.
   */
  findBy<K extends keyof T>(field: K, value: T[K]): T | undefined {
    return this.items.find((item) => item[field] === value);
  }

  /**
   * Return all items matching a predicate.
   */
  filter(predicate: (item: T) => boolean): T[] {
    return this.items.filter(predicate);
  }

  /**
   * Return a copy of all items.
   */
  all(): T[] {
    return [...this.items];
  }
}
