// This launcher is admitted by digest and receives a verified native executable.
// Never resolve an executable through PATH or accept command-line overrides.
const executable = process.env.PAPERCLIP_GROK_VERIFIED_EXECUTABLE;
if (!executable || !require("node:path").isAbsolute(executable)) {
  throw new Error("Verified Grok executable is unavailable");
}
const environment = { ...process.env };
delete environment.PAPERCLIP_GROK_VERIFIED_EXECUTABLE;
process.execve(executable, [executable, "agent", "--no-leader", "stdio"], environment);
