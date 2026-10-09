import type { Session } from "next-auth";
import type { JWT } from "next-auth/jwt";

type Assert<T extends true> = T;
type IsOptional<T, Key extends keyof T> = Pick<T, Key> extends Required<
  Pick<T, Key>
>
  ? false
  : true;

export type JwtIdIsOptional = Assert<IsOptional<JWT, "id">>;
export type JwtSessionVersionIsOptional = Assert<
  IsOptional<JWT, "sessionVersion">
>;
export type SessionIdIsRequired = Assert<
  IsOptional<Session["user"], "id"> extends false ? true : false
>;
export type SessionVersionIsRequired = Assert<
  IsOptional<Session["user"], "sessionVersion"> extends false ? true : false
>;
