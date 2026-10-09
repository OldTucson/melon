export function parseEmailFlag(args: string[]) {
  if (
    args.length !== 2 ||
    args[0] !== "--email" ||
    !args[1] ||
    args[1].startsWith("--")
  ) {
    throw new Error("Usage requires --email <email> and no positional values.");
  }

  return args[1];
}
