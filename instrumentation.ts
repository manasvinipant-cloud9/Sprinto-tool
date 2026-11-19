export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { installConsoleScrubber } = await import("./lib/scrub");
    installConsoleScrubber();
  }
}
