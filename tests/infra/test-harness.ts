/**
 * tests/infra/test-harness.ts
 * Vitest-compatible test harness powered by Node.js native test runner and assert.
 * Provides identical API to Vitest so tests can run in both Vitest and standalone Node.
 */

import * as nodeTest from 'node:test';
import * as assert from 'node:assert';

export const describe = nodeTest.describe;
export const it = nodeTest.it;
export const test = nodeTest.test;
export const beforeEach = nodeTest.beforeEach;
export const afterEach = nodeTest.afterEach;
export const beforeAll = nodeTest.before;
export const afterAll = nodeTest.after;

/**
 * Mock function implementation compatible with vi.fn()
 */
export interface MockFunction<T = any, Y extends any[] = any[]> {
  (...args: Y): T;
  mock: {
    calls: Y[];
    results: { type: 'return' | 'throw'; value: any }[];
    instances: any[];
  };
  mockReturnValue(val: T): MockFunction<T, Y>;
  mockResolvedValue(val: any): MockFunction<T, Y>;
  mockImplementation(fn: (...args: Y) => T): MockFunction<T, Y>;
  mockReset(): void;
  mockClear(): void;
}

export function fn<T = any, Y extends any[] = any[]>(implementation?: (...args: Y) => T): MockFunction<T, Y> {
  const calls: Y[] = [];
  const results: { type: 'return' | 'throw'; value: any }[] = [];
  const instances: any[] = [];

  let currentImpl = implementation || ((..._args: any[]) => undefined as unknown as T);

  const mockFn = function (this: any, ...args: Y): T {
    calls.push(args);
    instances.push(this);
    try {
      const res = currentImpl.apply(this, args);
      results.push({ type: 'return', value: res });
      return res;
    } catch (err) {
      results.push({ type: 'throw', value: err });
      throw err;
    }
  } as MockFunction<T, Y>;

  mockFn.mock = { calls, results, instances };

  mockFn.mockReturnValue = (val: T) => {
    currentImpl = () => val;
    return mockFn;
  };

  mockFn.mockResolvedValue = (val: any) => {
    currentImpl = () => Promise.resolve(val) as unknown as T;
    return mockFn;
  };

  mockFn.mockImplementation = (fn: (...args: Y) => T) => {
    currentImpl = fn;
    return mockFn;
  };

  mockFn.mockClear = () => {
    calls.length = 0;
    results.length = 0;
    instances.length = 0;
  };

  mockFn.mockReset = () => {
    mockFn.mockClear();
    currentImpl = implementation || ((..._args: any[]) => undefined as unknown as T);
  };

  return mockFn;
}

export function spyOn<T extends object, K extends keyof T>(obj: T, method: K) {
  const original = obj[method];
  const mock = fn((original as unknown as Function).bind(obj));
  obj[method] = mock as unknown as T[K];
  return {
    ...mock,
    mockRestore: () => {
      obj[method] = original;
    },
  };
}

export const vi = {
  fn,
  spyOn,
  clearAllMocks: () => {},
  resetAllMocks: () => {},
  waitFor: async <T>(predicate: () => Promise<T> | T, { timeout = 3000, interval = 50 }: { timeout?: number; interval?: number } = {}): Promise<T> => {
    const startTime = Date.now();
    while (Date.now() - startTime < timeout) {
      try {
        const result = await predicate();
        if (result) return result;
      } catch (e) {
        // Retry
      }
      await new Promise((r) => setTimeout(r, interval));
    }
    throw new Error(`vi.waitFor timed out after ${timeout}ms`);
  },
};

/**
 * Fluent expectation assertion object matching Jest / Vitest expect
 */
export function expect<T = any>(actual: T) {
  return {
    toBe(expected: any) {
      assert.strictEqual(actual, expected, `Expected ${actual} to be ${expected}`);
    },
    toEqual(expected: any) {
      assert.deepStrictEqual(actual, expected, `Expected deep equality`);
    },
    toBeDefined() {
      assert.notStrictEqual(actual, undefined, `Expected value to be defined`);
    },
    toBeUndefined() {
      assert.strictEqual(actual, undefined, `Expected value to be undefined`);
    },
    toBeNull() {
      assert.strictEqual(actual, null, `Expected value to be null`);
    },
    toBeTruthy() {
      assert.ok(Boolean(actual), `Expected ${actual} to be truthy`);
    },
    toBeFalsy() {
      assert.ok(!actual, `Expected ${actual} to be falsy`);
    },
    toBeGreaterThan(expected: number) {
      assert.ok((actual as any) > expected, `Expected ${actual} > ${expected}`);
    },
    toBeGreaterThanOrEqual(expected: number) {
      assert.ok((actual as any) >= expected, `Expected ${actual} >= ${expected}`);
    },
    toBeLessThan(expected: number) {
      assert.ok((actual as any) < expected, `Expected ${actual} < ${expected}`);
    },
    toBeLessThanOrEqual(expected: number) {
      assert.ok((actual as any) <= expected, `Expected ${actual} <= ${expected}`);
    },
    toContain(expected: any) {
      if (typeof actual === 'string') {
        assert.ok(actual.includes(expected), `Expected "${actual}" to contain "${expected}"`);
      } else if (Array.isArray(actual)) {
        assert.ok(actual.includes(expected), `Expected array to contain item`);
      } else {
        throw new Error(`toContain not supported on ${typeof actual}`);
      }
    },
    toHaveLength(len: number) {
      assert.strictEqual((actual as any)?.length, len, `Expected length ${len}, got ${(actual as any)?.length}`);
    },
    toHaveBeenCalled() {
      const mock = (actual as unknown as MockFunction).mock;
      assert.ok(mock && mock.calls.length > 0, `Expected mock function to have been called`);
    },
    toHaveBeenCalledTimes(n: number) {
      const mock = (actual as unknown as MockFunction).mock;
      assert.strictEqual(mock?.calls.length, n, `Expected mock to be called ${n} times, called ${mock?.calls.length}`);
    },
    toHaveBeenCalledWith(...expectedArgs: any[]) {
      const mock = (actual as unknown as MockFunction).mock;
      assert.ok(
        mock?.calls.some((args) => {
          try {
            assert.deepStrictEqual(args, expectedArgs);
            return true;
          } catch {
            return false;
          }
        }),
        `Expected mock to be called with ${JSON.stringify(expectedArgs)}`
      );
    },
    toThrow(expected?: string | RegExp) {
      assert.throws(actual as any, (err: any) => {
        if (!expected) return true;
        const msg = String(err?.message || err);
        if (typeof expected === 'string') return msg.includes(expected);
        return expected.test(msg);
      });
    },
    not: {
      toBe(expected: any) {
        assert.notStrictEqual(actual, expected, `Expected ${actual} not to be ${expected}`);
      },
      toEqual(expected: any) {
        assert.notDeepStrictEqual(actual, expected, `Expected deep inequality`);
      },
      toBeNull() {
        assert.notStrictEqual(actual, null, `Expected not to be null`);
      },
      toBeUndefined() {
        assert.notStrictEqual(actual, undefined, `Expected not to be undefined`);
      },
      toBeTruthy() {
        assert.ok(!actual, `Expected not to be truthy`);
      },
      toBeFalsy() {
        assert.ok(Boolean(actual), `Expected not to be falsy`);
      },
      toContain(expected: any) {
        if (typeof actual === 'string') {
          assert.ok(!actual.includes(expected), `Expected "${actual}" not to contain "${expected}"`);
        } else if (Array.isArray(actual)) {
          assert.ok(!actual.includes(expected), `Expected array not to contain item`);
        }
      },
      toHaveBeenCalled() {
        const mock = (actual as unknown as MockFunction).mock;
        assert.strictEqual(mock?.calls.length, 0, `Expected mock not to have been called`);
      },
    },
    rejects: {
      async toThrow(expected?: string | RegExp) {
        let threw = false;
        let caughtErr: any;
        try {
          await (actual as unknown as Promise<any>);
        } catch (err) {
          threw = true;
          caughtErr = err;
        }
        assert.ok(threw, `Expected promise to reject`);
        if (expected && caughtErr) {
          const msg = String(caughtErr?.message || caughtErr);
          if (typeof expected === 'string') {
            assert.ok(msg.includes(expected), `Expected rejection message to contain "${expected}", got "${msg}"`);
          } else {
            assert.ok(expected.test(msg), `Expected rejection message to match regex, got "${msg}"`);
          }
        }
      },
    },
  };
}

