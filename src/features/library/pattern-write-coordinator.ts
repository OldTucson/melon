"use client";

import type { QueryClient } from "@tanstack/react-query";
import { useState } from "react";

const queues = new WeakMap<QueryClient, Map<string, Promise<void>>>();

/** Reserve the whole target set before yielding; never hold one ID while waiting for another. */
export function enqueuePatternWrite<T>(
  client: QueryClient,
  ownerId: string,
  patternIds: readonly string[],
  task: () => Promise<T>,
) {
  const tails = queues.get(client) ?? new Map<string, Promise<void>>();
  queues.set(client, tails);
  const keys = [...new Set(patternIds)].map((id) => `${ownerId}:${id}`);
  const dependencies = [
    ...new Set(
      keys.flatMap((key) => (tails.has(key) ? [tails.get(key)!] : [])),
    ),
  ];
  const result = Promise.all(dependencies).then(task);
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  for (const key of keys) tails.set(key, tail);
  void tail.then(() => {
    for (const key of keys) if (tails.get(key) === tail) tails.delete(key);
  });
  return result;
}

export function usePatternWriteQueue(client: QueryClient, ownerId: string) {
  const [pendingCount, setPendingCount] = useState(0);
  return {
    isPending: pendingCount > 0,
    enqueue<T>(patternIds: readonly string[], task: () => Promise<T>) {
      setPendingCount((count) => count + 1);
      return enqueuePatternWrite(client, ownerId, patternIds, task).finally(
        () => setPendingCount((count) => count - 1),
      );
    },
  };
}
