/**
 * Desktop entry point.
 *
 * This is the file the Windows executable and the Linux binary are built from:
 * one binary, several behaviours, chosen by the first argument.
 *
 *   (no arguments)   launcher: reuse a running instance or start one, then open
 *                    the browser and return. The service keeps running.
 *   serve            run the HTTP service in the foreground (systemd uses this,
 *                    and the launcher spawns it detached)
 *   status           print service status
 *   stop / restart   control the running instance
 *   logs             print the recent log lines
 *   autostart on|off Windows only: write or remove the per-user Run entry
 *   --version        print the version
 *   --help           print usage
 *
 * The heavy lifting — HTTP, authentication, job queue, static assets — belongs to
 * `packages/server`. This file exists so "desktop" has an explicit entry that the
 * packaging scripts can point at, and so process-level behaviour (spawning the
 * detached service, opening a browser) has one obvious home.
 */
import { runCli } from '../../../packages/server/src/cli.ts'

runCli(process.argv.slice(2)).catch((error: unknown) => {
  process.stderr.write(`AI Debate: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
})
