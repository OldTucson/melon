import type { DefaultSession } from "@auth/core/types";

declare module "next-auth" {
  interface Session {
    user: DefaultSession["user"] & {
      id: string;
      sessionVersion: number;
    };
  }

  interface User {
    sessionVersion: number;
  }
}

declare module "@auth/core/types" {
  interface Session {
    user: DefaultSession["user"] & {
      id: string;
      sessionVersion: number;
    };
  }

  interface User {
    sessionVersion: number;
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    id?: string;
    sessionVersion?: number;
  }
}

declare module "@auth/core/jwt" {
  interface JWT {
    id?: string;
    sessionVersion?: number;
  }
}
