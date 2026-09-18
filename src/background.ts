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
        fetchData(sender.url)
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

  return fetch(url)
    .then(res => res.text())
    .catch(err => {
      console.error(err)
      return err.message
    })
}

/**
 * List a local directory by fetching Chrome's file:// directory listing page.
 * Each entry is emitted as `addRow("name","raw",isDir,size,"size",mtime,"mtime")`.
 */
async function listDir(url: string) {
  if (!url || !url.startsWith('file://')) {
    throw new Error('listDir: only file:// urls are supported')
  }
  const res = await fetch(url)
  if (!res.ok) throw new Error(`listDir: ${res.status}`)
  const html = await res.text()
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
