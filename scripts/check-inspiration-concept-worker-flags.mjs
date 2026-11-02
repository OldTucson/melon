// Pure environment probe: no dotenv, application imports, database or provider access.
if (process.argv.length !== 2) {
  console.log(JSON.stringify({ status: "invalid_arguments" }));
  process.exitCode = 1;
} else {
  const flags = {
    conceptImagesEnabled: process.env.INSPIRATION_CONCEPT_IMAGES_ENABLED === "true",
    releaseApproved: process.env.INSPIRATION_CONCEPT_RELEASE_APPROVED === "true",
  };
  console.log(JSON.stringify(flags));
  process.exitCode = flags.conceptImagesEnabled && flags.releaseApproved ? 0 : 1;
}
