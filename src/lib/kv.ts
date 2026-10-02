// 存储后端：浏览器用 localStorage，自测脚本用内存 Map
export interface KV {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function memoryKV(): KV {
  const map = new Map<string, string>();
  return {
    getItem: (key) => (map.has(key) ? map.get(key)! : null),
    setItem: (key, value) => {
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    },
  };
}

export function defaultKV(): KV {
  return typeof localStorage === "undefined" ? memoryKV() : localStorage;
}
