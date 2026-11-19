/**
 * A model stub for the Linux acceptance run.
 *
 * The container that proves the systemd unit starts and survives a `kill -9` has no
 * Node.js in it (the product ships its own runtime; the container is just systemd +
 * our binary). So the model endpoint runs on the *host* and the container reaches it
 * over the host network.
 *
 * It answers the way a compliant model would: it echoes the target the prompt asks
 * for, so the engine's "did the model answer the right person" check passes for the
 * right reason rather than being disabled.
 */
import { createServer } from 'node:http'

const PORT = Number(process.env.MOCK_PORT ?? 17863)

createServer((request, response) => {
  let body = ''
  request.setEncoding('utf8')
  request.on('data', (chunk) => {
    body += chunk
  })
  request.on('end', () => {
    const target = /回复对象的 post id 应为\s*([A-Za-z0-9:_-]+)/.exec(body)?.[1] ?? 'f2'
    const draft = {
      status: 'ok',
      owner_position: '对方的结论建立在个例上。',
      opponent_position: '年轻人吃不了苦。',
      main_dispute: '能否用个别现象概括整体。',
      latest_argument: '用身边例子否定整体结论。',
      response_target_id: target,
      strategy: 'point_out_contradiction',
      confidence: 0.7,
      uncertainties: [],
      reply: '你举的例子只能说明有人这样，不能说明所有人都这样。',
    }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(
      JSON.stringify({
        choices: [{ message: { role: 'assistant', content: JSON.stringify(draft) } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
    )
  })
}).listen(PORT, '0.0.0.0', () => {
  process.stdout.write(`mock model listening on ${PORT}\n`)
})
