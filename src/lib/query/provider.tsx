"use client";

import { createContext, useContext } from "react";
import { QueryClientProvider } from "@tanstack/react-query";

import { getQueryClient } from "./client";

export {
  ApiResponseError,
  createQueryClient,
  getQueryClient,
  readApiResponse,
} from "./client";

const QueryOwnerContext = createContext<string | null>(null);

export function QueryOwnerProvider({
  children,
  ownerId,
}: {
  children: React.ReactNode;
  ownerId: string;
}) {
  return (
    <QueryOwnerContext.Provider value={ownerId}>
      {children}
    </QueryOwnerContext.Provider>
  );
}

export function useQueryOwnerId() {
  const ownerId = useContext(QueryOwnerContext);
  if (!ownerId) throw new Error("Query owner context is required");
  return ownerId;
}

export function QueryProvider({
  children,
  ownerId,
}: {
  children: React.ReactNode;
  ownerId: string;
}) {
  return (
    <QueryClientProvider client={getQueryClient(ownerId)}>
      <QueryOwnerProvider ownerId={ownerId}>{children}</QueryOwnerProvider>
    </QueryClientProvider>
  );
}
