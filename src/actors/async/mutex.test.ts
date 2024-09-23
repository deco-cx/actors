import { assertEquals, assertNotEquals } from "@std/assert";
import { delay } from "@std/async";
import { Mutex } from "./mutex.ts"; // Assuming the Mutex class is in mutex.ts

Deno.test("Mutex - Basic locking and unlocking", async () => {
  const mutex = new Mutex();
  let value = 0;

  const increment = async () => {
    const unlock = await mutex.lock();
    const currentValue = value;
    await delay(10); // Simulate some async work
    value = currentValue + 1;
    unlock[Symbol.dispose]();
  };

  await Promise.all([increment(), increment(), increment()]);
  assertEquals(value, 3);
});

Deno.test("Mutex - Wait for lock", async () => {
  const mutex = new Mutex();
  let value = "initial";

  const unlock = await mutex.lock();

  await new Promise<void>((resolve) => {
    setTimeout(() => {
      value = "changed";
      unlock[Symbol.dispose]();
      resolve();
    }, 50);
  });

  await mutex.wait();
  assertEquals(value, "changed");
});

Deno.test("Mutex - Multiple waiters", async () => {
  const mutex = new Mutex();
  const order: number[] = [];

  const waiter = async (id: number) => {
    await mutex.wait();
    order.push(id);
  };

  const unlock = await mutex.lock();

  const waiterPromises = [
    waiter(1),
    waiter(2),
    waiter(3),
  ];

  await delay(10); // Give some time for waiters to queue up
  unlock[Symbol.dispose]();

  await Promise.all(waiterPromises);

  assertEquals(order, [1, 2, 3]);
});

Deno.test("Mutex - Lock contention", async () => {
  const mutex = new Mutex();
  let value = 0;
  const results: number[] = [];

  const increment = async () => {
    const unlock = await mutex.lock();
    const currentValue = value;
    await delay(10); // Simulate some async work
    value = currentValue + 1;
    results.push(value);
    unlock[Symbol.dispose]();
  };

  await Promise.all([
    increment(),
    increment(),
    increment(),
    increment(),
    increment(),
  ]);

  assertEquals(value, 5);
  assertEquals(results, [1, 2, 3, 4, 5]);
});

Deno.test("Mutex - Immediate unlock", async () => {
  const mutex = new Mutex();
  const unlock = await mutex.lock();
  unlock[Symbol.dispose]();

  const unlock2 = await mutex.lock();
  assertNotEquals(unlock, unlock2);
  unlock2[Symbol.dispose]();
});
