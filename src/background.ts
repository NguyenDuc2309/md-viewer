import storage from '@/core/storage'
import commands from '@/core/commands'

chrome.runtime.onMessage.addListener(({ action, data }, sender, callback) => {
  messageHandler(action, data, sender, callback)
  return true
})

async function messageHandler(
  action: string,
  data: any,
  sender: chrome.runtime.MessageSender,
  callback?: (response?: any) => void,
) {
  try {
    switch (action) {
      case 'storage':
        await storage.set({ [data.key]: data.value })
        updatePage(data.key, data.value)
        callback?.(data)
        break
      case 'fetch':
        fetchData((data && data.url) || sender.url)
          .then(res => callback?.(res))
          .catch(() => callback?.(null))
        break
      case 'listDir':
        listDir(data.url)
          .then(entries => callback?.({ entries }))
          .catch(err => callback?.({ error: String(err?.message || err) }))
        break
      default:
        callback?.()
        break
    }
  } catch (err) {
    callback?.()
  }
}

async function fetchData(url?: string) {
  if (!url) {
    const error = new Error('Fetch error: URL is undefined.')
    console.error(error)
    return error.message
  }

  return fetchText(url).catch(err => {
    console.error(err)
    return err.message
  })
}

/** Read a URL as text; `file://` goes through the offscreen document. */
async function fetchText(url: string): Promise<string> {
  if (url.startsWith('file://')) return fetchViaOffscreen(url)
  return fetch(url).then(res => res.text())
}

let offscreenCreating: Promise<void> | null = null

async function ensureOffscreen() {
  const offscreen = (chrome as any).offscreen
  if (!offscreen) {
    throw new Error('Offscreen documents are not supported by this browser.')
  }
  if (offscreenCreating) return offscreenCreating
  offscreenCreating = offscreen
    .createDocument({
      url: 'offscreen.html',
      reasons: ['DOM_PARSER'],
      justification: 'Read local markdown files and directory listings',
    })
    .catch((err: Error) => {
      // Already exists from an earlier call - fine
      if (!/single offscreen document/i.test(err.message)) throw err
    })
    .finally(() => {
      offscreenCreating = null
    })
  return offscreenCreating
}

async function fetchViaOffscreen(url: string): Promise<string> {
  await ensureOffscreen()
  const ask = () =>
    chrome.runtime.sendMessage({ action: 'offscreen:fetch', data: { url } })
  // The document may still be booting right after creation - retry once
  let res = await ask().catch(() => null)
  if (!res) {
    await new Promise(r => setTimeout(r, 150))
    res = await ask().catch(() => null)
  }
  if (!res) throw new Error('Offscreen document did not respond.')
  if (res.error) throw new Error(res.error)
  return res.text
}

/**
 * List a local directory by fetching Chrome's file:// directory listing page.
 * Each entry is emitted as `addRow("name","raw",isDir,size,"size",mtime,"mtime")`.
 */
async function listDir(url: string) {
  if (!url || !url.startsWith('file://')) {
    throw new Error('listDir: only file:// urls are supported')
  }
  const html = await fetchViaOffscreen(url)
  const re = /addRow\(("(?:[^"\\]|\\.)*"),("(?:[^"\\]|\\.)*"),(\d)/g
  const entries: { name: string; isDir: boolean }[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(html))) {
    let name: string
    try {
      name = JSON.parse(m[1])
    } catch {
      continue
    }
    if (name === '..' || name === '.') continue
    entries.push({ name, isDir: m[3] === '1' })
  }
  if (entries.length === 0 && !/addRow|<script>start\(/.test(html)) {
    throw new Error('listDir: not a directory listing')
  }
  return entries
}

// Chrome extension shortcuts
chrome.commands.onCommand.addListener(action => {
  commands[action]?.(messageHandler)
})

const actionMap = {
  enable: 'reload',
  refresh: 'toggleRefresh',
  centered: 'toggleCentered',
  mdPlugins: 'updateMdPlugins',
  pageTheme: 'updatePageTheme',
  hiddenSide: 'toggleSide',
}

function updatePage(key: keyof typeof actionMap, value?: any) {
  const action = actionMap[key]
  if (!action) return
  chrome.tabs.query({ currentWindow: true, active: true }, tabs => {
    if (tabs && tabs.length && tabs[0].id !== undefined) {
      try {
        const p = chrome.tabs.sendMessage(
          tabs[0].id,
          { action, data: { key, value } },
          () => {
            if (chrome.runtime.lastError) {
              // Active tab doesn't have md-reader content script (e.g. chrome://extensions)
            }
          },
        )
        if (p && typeof p.catch === 'function') {
          p.catch(() => {})
        }
      } catch (err) {
        // Ignore
      }
    }
  })
}

chrome.runtime.setUninstallURL(
  'https://github.com/orgs/md-reader/discussions/51',
)
