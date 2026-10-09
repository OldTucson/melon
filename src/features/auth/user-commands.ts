import { parseEmailFlag } from "@/features/auth/account-command";

type PromptPassword = (options: {
  message: string;
  mask: "*";
}) => Promise<string>;

type SharedDependencies = {
  promptPassword: PromptPassword;
};

type CreateUserServices = {
  closeDatabase: () => Promise<void>;
  createUser: (input: {
    email: string;
    displayName: string;
    password: string;
  }) => Promise<unknown>;
};

type ResetPasswordServices = {
  closeDatabase: () => Promise<void>;
  resetUserPassword: (input: {
    email: string;
    password: string;
  }) => Promise<unknown>;
};

async function readConfirmedPassword(promptPassword: PromptPassword) {
  const password = await promptPassword({ message: "Password", mask: "*" });
  const confirmation = await promptPassword({
    message: "Confirm password",
    mask: "*",
  });

  if (password !== confirmation) {
    throw new Error("Passwords do not match.");
  }

  return password;
}

export async function runCreateUserCommand(
  args: string[],
  dependencies: SharedDependencies & {
    loadServices: () => Promise<CreateUserServices>;
  },
) {
  const email = parseEmailFlag(args).trim().toLowerCase();
  const password = await readConfirmedPassword(dependencies.promptPassword);
  const { closeDatabase, createUser } = await dependencies.loadServices();

  try {
    await createUser({
      email,
      displayName: email.split("@")[0] || "User",
      password,
    });
  } finally {
    await closeDatabase();
  }
}

export async function runResetPasswordCommand(
  args: string[],
  dependencies: SharedDependencies & {
    loadServices: () => Promise<ResetPasswordServices>;
  },
) {
  const email = parseEmailFlag(args).trim().toLowerCase();
  const password = await readConfirmedPassword(dependencies.promptPassword);
  const { closeDatabase, resetUserPassword } = await dependencies.loadServices();

  try {
    await resetUserPassword({ email, password });
  } finally {
    await closeDatabase();
  }
}
