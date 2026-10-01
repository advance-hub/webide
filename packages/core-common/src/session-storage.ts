export const StorageService = Symbol('IStorageService');

/** Session-scoped storage contract shared by browser providers and workspace clients. */
export interface StorageService {
  setData<T>(key: string, data: T): void;
  setData<T>(key: string, data: T): Promise<void> | void;

  getData<T>(key: string, defaultValue: T): Promise<T>;
  getData<T>(key: string, defaultValue: T): T;
  getData<T>(key: string): Promise<T | undefined>;
  getData<T>(key: string): T | undefined;

  removeData(key: string): Promise<void> | void;
  removeData(key: string): void;
}
