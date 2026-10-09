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
  const [{ createUser }, { closeDatabase }] = await Promise.all([
    import("@/features/auth/user-admin"),
    import("@/lib/db/client"),
  ]);

  try {
    const normalizedEmail = email.trim().toLowerCase();
    await createUser({
      email: normalizedEmail,
      displayName: normalizedEmail.split("@")[0] || "User",
      password,
    });
    console.log("User created.");
  } finally {
    await closeDatabase();
  }
};

run().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Command failed.");
  process.exitCode = 1;
});
