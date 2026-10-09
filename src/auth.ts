import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";

import { authorizeCredentials } from "@/features/auth/credentials";

export { authorizeCredentials } from "@/features/auth/credentials";

export const { handlers, auth, signIn, signOut } = NextAuth({
  pages: { signIn: "/login" },
  session: { strategy: "jwt" },
  providers: [
    Credentials({
      credentials: {
        email: { label: "邮箱", type: "email" },
        password: { label: "密码", type: "password" },
      },
      authorize: authorizeCredentials,
    }),
  ],
  callbacks: {
    jwt({ token, user }) {
      if (user?.id && typeof user.sessionVersion === "number") {
        token.id = user.id;
        token.sessionVersion = user.sessionVersion;
      }
      return token;
    },
    session({ session, token }) {
      if (
        session.user &&
        typeof token.id === "string" &&
        typeof token.sessionVersion === "number"
      ) {
        session.user.id = token.id;
        session.user.sessionVersion = token.sessionVersion;
      }
      return session;
    },
  },
});
