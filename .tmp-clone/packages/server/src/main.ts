/**
 * The server entry point.
 *
 * Deliberately a separate file from `apps/desktop/src/main.ts` even though the two
 * currently do the same thing. `npm start`, the systemd unit and the packaged
 * executable all name an entry file, and an entry that is "the other package's
 * entry" is the kind of implicit wiring that breaks when one of them grows a
 * startup-only concern. The desktop entry owns launcher behaviour (browser,
 * single-instance reuse); this one owns "run the service".
 */
import { runCli } from './cli.ts'

runCli(process.argv.slice(2)).catch((error: unknown) => {
  process.stderr.write(`AI Debate: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
})
