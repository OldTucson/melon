import { password as promptPassword } from "@inquirer/prompts";
import nextEnv from "@next/env";

import { runCreateUserCommand } from "@/features/auth/user-commands";

const loadServices = async () => {
  nextEnv.loadEnvConfig(process.cwd());
  const [{ createUser }, { closeDatabase }] = await Promise.all([
    import("@/features/auth/user-admin"),
    import("@/lib/db/client"),
  ]);

  return { closeDatabase, createUser };
};

runCreateUserCommand(process.argv.slice(2), { loadServices, promptPassword })
  .then(() => console.log("User created."))
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Command failed.");
    process.exitCode = 1;
  });
