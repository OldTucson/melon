import { password as promptPassword } from "@inquirer/prompts";
import nextEnv from "@next/env";

import { parseEmailFlag } from "@/features/auth/account-command";

const run = async () => {
  const email = parseEmailFlag(process.argv.slice(2));
  const password = await promptPassword({ message: "Password", mask: "*" });
  const confirmation = await promptPassword({
    message: "Confirm password",
    mask: "*",
  });

  if (password !== confirmation) {
    throw new Error("Passwords do not match.");
  }

  nextEnv.loadEnvConfig(process.cwd());
  const [{ resetUserPassword }, { closeDatabase }] = await Promise.all([
    import("@/features/auth/user-admin"),
    import("@/lib/db/client"),
  ]);

  try {
    await resetUserPassword({ email, password });
    console.log("Password reset.");
  } finally {
    await closeDatabase();
  }
};

run().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Command failed.");
  process.exitCode = 1;
});
