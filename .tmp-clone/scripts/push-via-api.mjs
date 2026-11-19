/**
 * Push through the GitHub REST API when the git transport is blocked.
 *
 * On this network `git push` over HTTPS is refused by the proxy (`CONNECT tunnel
 * failed, 502`), while the REST API answers. The Git Data API can replay commits
 * one at a time, which is enough to publish a repository — but replaying history
 * is only safe under three conditions, and all three are enforced here:
 *
 *   1. The parent must be the remote's current head. A non-fast-forward is refused,
 *      never forced.
 *   2. The tree produced for each commit must equal `git rev-parse <commit>^{tree}`
 *      locally. If it does not, the script stops — publishing a different tree than
 *      the one that was tested is worse than not publishing.
 *   3. A commit already present on the remote is detected by *tree*, not by sha,
 *      because the API normalises author dates and therefore produces different
 *      hashes for identical content.
 *
 * Usage:
 *   GITHUB_REPOSITORY=owner/repo PUSH_BRANCH=main GITHUB_TOKEN=... \
 *   node scripts/push-via-api.mjs [--target HEAD] [--base main]
 */
import { execFileSync } from 'node:child_process'

const API = 'https://api.github.com'

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8', shell: false, maxBuffer: 128 * 1024 * 1024 })
}

async function api(token, method, path, body) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await response.text()
  let parsed
  try {
    parsed = text === '' ? undefined : JSON.parse(text)
  } catch {
    parsed = undefined
  }
  if (!response.ok) throw new Error(`${method} ${path} → ${response.status} ${parsed?.message ?? text.slice(0, 200)}`)
  return parsed
}

/** The files one commit changed relative to its parent, as the Git Data API wants. */
function changesOf(commit) {
  const parent = git('rev-parse', `${commit}^`).trim()
  const raw = git('diff-tree', '-r', '--no-commit-id', '--name-status', '-z', parent, commit)
  const parts = raw.split('\u0000').filter((entry) => entry !== '')
  const changes = []
  for (let index = 0; index < parts.length; index += 2) {
    const status = parts[index]
    const path = parts[index + 1]
    if (status === undefined || path === undefined) break
    changes.push({ path, deleted: status.startsWith('D') })
  }
  return { parent, changes }
}

function blobOf(commit, path) {
  const content = execFileSync('git', ['show', `${commit}:${path}`], {
    encoding: 'buffer',
    shell: false,
    maxBuffer: 128 * 1024 * 1024,
  })
  return content.toString('base64')
}

async function main() {
  const args = process.argv.slice(2)
  const flag = (name, fallback) => {
    const index = args.indexOf(`--${name}`)
    return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback
  }

  const [owner, repo] = (process.env.GITHUB_REPOSITORY ?? '').split('/')
  const branch = process.env.PUSH_BRANCH ?? 'main'
  const target = flag('target', 'HEAD')
  const baseBranch = flag('base', 'main')
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? ''
  if (owner === undefined || repo === undefined || token === '') {
    throw new Error('需要 GITHUB_REPOSITORY 与 GITHUB_TOKEN')
  }

  const head = git('rev-parse', target).trim()
  const localTree = git('rev-parse', `${head}^{tree}`).trim()

  let remoteSha
  let branchExists = true
  try {
    const remote = await api(token, 'GET', `/repos/${owner}/${repo}/git/ref/heads/${branch}`)
    remoteSha = remote.object.sha
  } catch (error) {
    // An empty repository answers 409 ("Git Repository is empty") rather than 404
    // for a ref that cannot exist yet.
    const message = String(error.message)
    if (!message.includes('404') && !message.includes('409')) throw error
    branchExists = false
    try {
      const baseline = await api(token, 'GET', `/repos/${owner}/${repo}/git/ref/heads/${baseBranch}`)
      remoteSha = baseline.object.sha
      console.log(`远端分支 ${branch} 不存在，以 ${baseBranch}（${remoteSha.slice(0, 8)}）为父`)
    } catch {
      // A brand-new repository has no refs at all; the first commit has no parent.
      const repository = await api(token, 'GET', `/repos/${owner}/${repo}`)
      if (repository.size !== 0) throw new Error(`远端没有 ${baseBranch}，且仓库非空：请手动确认状态`)
      remoteSha = undefined
      console.log('远端为空仓库：将创建初始提交')
    }
  }

  let parentTree
  let parent
  if (remoteSha !== undefined) {
    const remoteCommit = await api(token, 'GET', `/repos/${owner}/${repo}/git/commits/${remoteSha}`)
    if (remoteCommit.tree.sha === localTree) {
      console.log(`已一致（tree ${localTree.slice(0, 8)}）：内容相同，无需重放`)
      return
    }
    const allLocal = git('rev-list', head).trim().split('\n').filter(Boolean)
    const base = allLocal.find((commit) => git('rev-parse', `${commit}^{tree}`).trim() === remoteCommit.tree.sha)
    if (base === undefined) {
      // The remote was initialised through the Contents API, so its first commit is
      // not part of local history. Publishing the current tree on top of it keeps
      // the remote ref a fast-forward and still verifies the tree byte for byte.
      console.log(`远端头 ${remoteSha.slice(0, 8)} 不在本地历史中（仓库由接口初始化）：按当前树创建一个导入提交`)
      const created = await importCommit({ token, owner, repo, commit: head, parent: remoteSha })
      await api(token, 'PATCH', `/repos/${owner}/${repo}/git/refs/heads/${branch}`, { sha: created.sha, force: false })
      const check = await api(token, 'GET', `/repos/${owner}/${repo}/git/commits/${created.sha}`)
      if (check.tree.sha !== localTree) throw new Error('导入提交的树与本地不一致')
      console.log(`完成：远端 ${branch} = ${created.sha.slice(0, 8)}（tree 与本地一致）`)
      return
    }
    const commits = git('rev-list', '--reverse', `${base}..${head}`).trim().split('\n').filter(Boolean)
    console.log(`远端 ${branch} = ${remoteSha.slice(0, 8)}，需要重放 ${commits.length} 个提交`)
    parent = remoteSha
    parentTree = remoteCommit.tree.sha

    for (const commit of commits) {
      const created = await replayCommit({ token, owner, repo, commit, parent, parentTree })
      parent = created.sha
      parentTree = created.tree
    }
  } else {
    const commits = git('rev-list', '--reverse', head).trim().split('\n').filter(Boolean)
    console.log(`需要重放 ${commits.length} 个提交（无父提交）`)
    for (const [index, commit] of commits.entries()) {
      const created = await replayCommit({
        token,
        owner,
        repo,
        commit,
        parent: index === 0 ? undefined : parent,
        parentTree: index === 0 ? undefined : parentTree,
      })
      parent = created.sha
      parentTree = created.tree
    }
  }

  if (branchExists) {
    await api(token, 'PATCH', `/repos/${owner}/${repo}/git/refs/heads/${branch}`, { sha: parent, force: false })
  } else {
    await api(token, 'POST', `/repos/${owner}/${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha: parent })
  }

  const after = await api(token, 'GET', `/repos/${owner}/${repo}/git/ref/heads/${branch}`)
  const afterCommit = await api(token, 'GET', `/repos/${owner}/${repo}/git/commits/${after.object.sha}`)
  if (afterCommit.tree.sha !== localTree) {
    throw new Error(`推送后远端 tree ${afterCommit.tree.sha.slice(0, 8)} ≠ 本地 ${localTree.slice(0, 8)}`)
  }
  console.log(`完成：远端 ${branch} = ${after.object.sha.slice(0, 8)}（tree 与本地一致）`)
}

/** Publish the whole tree of `commit` as one commit on top of `parent`. */
async function importCommit({ token, owner, repo, commit, parent }) {
  const files = git('ls-tree', '-r', '--name-only', commit).trim().split('\n').filter(Boolean)
  const tree = []
  for (const path of files) {
    const blob = await api(token, 'POST', `/repos/${owner}/${repo}/git/blobs`, {
      content: blobOf(commit, path),
      encoding: 'base64',
    })
    const mode = git('ls-tree', commit, '--', path).trim().split(' ')[0] ?? '100644'
    tree.push({ path, mode, type: 'blob', sha: blob.sha })
  }
  const newTree = await api(token, 'POST', `/repos/${owner}/${repo}/git/trees`, { tree })
  const expected = git('rev-parse', `${commit}^{tree}`).trim()
  if (newTree.sha !== expected) {
    throw new Error(`导入树对不上：API ${newTree.sha.slice(0, 8)} vs 本地 ${expected.slice(0, 8)}`)
  }
  const message = git('log', '-1', '--format=%B', commit)
  const authorName = git('log', '-1', '--format=%an', commit).trim()
  const authorEmail = git('log', '-1', '--format=%ae', commit).trim()
  const authorDate = git('log', '-1', '--format=%aI', commit).trim()
  return api(token, 'POST', `/repos/${owner}/${repo}/git/commits`, {
    message,
    tree: newTree.sha,
    parents: [parent],
    author: { name: authorName, email: authorEmail, date: authorDate },
    committer: { name: authorName, email: authorEmail, date: authorDate },
  })
}

async function replayCommit({ token, owner, repo, commit, parent, parentTree }) {
  const changes = parent === undefined ? undefined : changesOf(commit).changes
  const tree = []
  if (changes === undefined) {
    // Root commit: every tracked file becomes a blob, no base tree.
    const files = git('ls-tree', '-r', '--name-only', commit).trim().split('\n').filter(Boolean)
    for (const path of files) {
      const blob = await api(token, 'POST', `/repos/${owner}/${repo}/git/blobs`, {
        content: blobOf(commit, path),
        encoding: 'base64',
      })
      const mode = git('ls-tree', commit, '--', path).trim().split(' ')[0] ?? '100644'
      tree.push({ path, mode, type: 'blob', sha: blob.sha })
    }
  } else {
    for (const change of changes) {
      if (change.deleted) {
        tree.push({ path: change.path, mode: '100644', type: 'blob', sha: null })
        continue
      }
      const blob = await api(token, 'POST', `/repos/${owner}/${repo}/git/blobs`, {
        content: blobOf(commit, change.path),
        encoding: 'base64',
      })
      const mode = git('ls-tree', commit, '--', change.path).trim().split(' ')[0] ?? '100644'
      tree.push({ path: change.path, mode, type: 'blob', sha: blob.sha })
    }
  }

  const newTree = await api(
    token,
    'POST',
    `/repos/${owner}/${repo}/git/trees`,
    parentTree === undefined ? { tree } : { base_tree: parentTree, tree },
  )
  const expected = git('rev-parse', `${commit}^{tree}`).trim()
  if (newTree.sha !== expected) {
    throw new Error(`提交 ${commit.slice(0, 8)} 的树对不上：API ${newTree.sha.slice(0, 8)} vs 本地 ${expected.slice(0, 8)}`)
  }

  const message = git('log', '-1', '--format=%B', commit)
  const authorName = git('log', '-1', '--format=%an', commit).trim()
  const authorEmail = git('log', '-1', '--format=%ae', commit).trim()
  const authorDate = git('log', '-1', '--format=%aI', commit).trim()

  const created = await api(token, 'POST', `/repos/${owner}/${repo}/git/commits`, {
    message,
    tree: newTree.sha,
    parents: parent === undefined ? [] : [parent],
    author: { name: authorName, email: authorEmail, date: authorDate },
    committer: { name: authorName, email: authorEmail, date: authorDate },
  })
  console.log(`  ${commit.slice(0, 8)} → ${created.sha.slice(0, 8)}（tree 一致）`)
  return { sha: created.sha, tree: newTree.sha }
}

main().catch((error) => {
  process.stderr.write(`失败：${error.message}\n`)
  process.exitCode = 1
})
