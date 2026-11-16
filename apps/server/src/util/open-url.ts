import { windowsSystemTool } from "./windows-acl";

/**
 * The command that opens a web address in the owner's default browser.
 *
 * Windows has no `xdg-open`. It runs the shell's own URL handler,
 * `rundll32 url.dll,FileProtocolHandler`, by absolute path under
 * `%SystemRoot%\System32` (`windowsSystemTool("rundll32")`, resolved the way
 * it resolves `whoami` and `icacls`): a bare name would let a planted
 * executable earlier on PATH run with the owner's rights. macOS keeps `open`;
 * Linux keeps `xdg-open`.
 *
 * Only http and https addresses are accepted. The Windows handler will also
 * launch a file path or a protocol handler, and the address is never a thing
 * the owner or the model should be able to turn into a program launch.
 */
export function browserOpenCommand(
  url: string,
  platform: NodeJS.Platform = process.platform,
  env: Record<string, string | undefined> = process.env,
): string[] {
  if (!/^https?:\/\/\S+$/i.test(url)) throw new Error("Only http and https addresses can be opened in the browser.");
  if (platform === "win32") {
    // windowsSystemTool throws unless SystemRoot is an absolute drive path.
    return [windowsSystemTool("rundll32", env), "url.dll,FileProtocolHandler", url];
  }
  return [platform === "darwin" ? "open" : "xdg-open", url];
}
