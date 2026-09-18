import className from '@/config/class-name'
import i18n from '@/config/i18n'
import {
  type FileTreeNode,
  filterNode,
  icons,
  isMarkdownFile,
  renderNodeChildren,
  revealActive,
  shouldSkipDir,
  sortNodes,
  sortTree,
} from '@/core/folder-tree'

/**
 * Folder browser for local `file://` pages.
 *
 * "Open Folder" shows the browser's folder picker. The picked folder's absolute
 * location is inferred from the file open in this tab, then persisted in
 * chrome.storage (plus a recent list). From then on the tree is rebuilt on
 * every page load by listing the directory through the background script (an
 * offscreen document fetches Chrome's file:// directory listing), and files are
 * opened by navigating to their URL, so the current document is always
 * highlighted and no picker or permission prompt is needed again.
 */

const MAX_RECENT = 10
const MAX_SEARCH_DIRS = 400
const MAX_SIBLING_SCAN = 6
const MAX_SCAN_LISTINGS = 120
const STORAGE_ROOT = 'folderRoot'
const STORAGE_EXPANDED = 'folderExpanded'
const STORAGE_RECENT = 'recentFolders'

interface DirEntry {
  name: string
  isDir: boolean
}

interface PathFolderCallbacks {
  /** Only used when the picked folder's location could not be resolved */
  onFileSelected: (content: string, name: string, path: string) => void
  onFolderClosed?: () => void
}

function storageGet<T = any>(keys: string[]): Promise<T> {
  return new Promise(resolve => chrome.storage.local.get(keys, resolve as any))
}
function storageSet(data: object): Promise<void> {
  return new Promise(resolve => chrome.storage.local.set(data, resolve))
}

function listDir(url: string): Promise<DirEntry[]> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ action: 'listDir', data: { url } }, res => {
      if (chrome.runtime.lastError || !res) {
        reject(new Error(chrome.runtime.lastError?.message || 'no response'))
      } else if (res.error) {
        reject(new Error(res.error))
      } else {
        resolve(res.entries)
      }
    })
  })
}

/** file:///a/b/c.md -> file:///a/b/ */
function dirOf(fileUrl: string): string {
  const clean = fileUrl.split(/[?#]/)[0]
  return clean.slice(0, clean.lastIndexOf('/') + 1)
}

/** file:///a/b/ -> file:///a/ ; file:/// -> null */
function parentOf(dirUrl: string): string | null {
  const trimmed = dirUrl.replace(/\/+$/, '')
  if (trimmed === 'file://' || trimmed === 'file:') return null
  const parent = trimmed.slice(0, trimmed.lastIndexOf('/') + 1)
  return parent.length >= 'file:///'.length ? parent : 'file:///'
}

function decode(s: string): string {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

function nameOf(dirUrl: string): string {
  const trimmed = dirUrl.replace(/\/+$/, '')
  return decode(trimmed.slice(trimmed.lastIndexOf('/') + 1)) || '/'
}

function displayPath(url: string): string {
  return decode(url.replace(/^file:\/\//, ''))
}

/** Compare two file:// urls ignoring percent-encoding differences */
function sameUrl(a: string, b: string): boolean {
  return decode(a) === decode(b)
}

export class PathFolderManager {
  private rootUrl: string | null = null
  private rootNode: FileTreeNode | null = null
  /** Tree built from picked File objects when the location is unknown */
  private memoryMode: boolean = false
  private activeMemoryPath: string | null = null
  private expanded: Set<string> = new Set()
  private recents: string[] = []
  private searchQuery: string = ''
  private showRecents: boolean = false
  private loading: boolean = false
  private notice: string = ''
  private fullyLoaded: boolean = false
  private localize: (key: string) => string = i18n()
  private container: HTMLElement
  private fileInput: HTMLInputElement
  private callbacks: PathFolderCallbacks
  private currentFile: string = window.location.href.split(/[?#]/)[0]

  constructor(
    container: HTMLElement,
    callbacks: PathFolderCallbacks,
    language?: string,
  ) {
    this.container = container
    this.callbacks = callbacks
    this.localize = i18n(language)

    // Native folder picker (kept synchronous so the click gesture is preserved)
    this.fileInput = document.createElement('input')
    this.fileInput.type = 'file'
    // @ts-ignore
    this.fileInput.webkitdirectory = true
    // @ts-ignore
    this.fileInput.directory = true
    this.fileInput.multiple = true
    this.fileInput.style.display = 'none'
    this.fileInput.addEventListener('change', () => {
      const files = this.fileInput.files
      if (files && files.length > 0) this.onFolderPicked(files)
    })
    document.body.appendChild(this.fileInput)

    this.render()
    this.restore()
  }

  public setLanguage(language?: string) {
    this.localize = i18n(language)
    this.render()
  }

  public pickFolder() {
    this.fileInput.value = ''
    this.fileInput.click()
  }

  /* ---------- persistence ---------- */

  private async restore() {
    const data = await storageGet([
      STORAGE_ROOT,
      STORAGE_EXPANDED,
      STORAGE_RECENT,
    ])
    this.recents = Array.isArray(data[STORAGE_RECENT])
      ? data[STORAGE_RECENT]
      : []
    const root: string | undefined = data[STORAGE_ROOT]
    if (root) {
      const saved = (data[STORAGE_EXPANDED] || {})[root]
      this.expanded = new Set(Array.isArray(saved) ? saved : [])
      await this.openRoot(root, false)
    } else {
      this.render()
    }
  }

  private async persistExpanded() {
    if (!this.rootUrl) return
    const data = await storageGet([STORAGE_EXPANDED])
    const map = data[STORAGE_EXPANDED] || {}
    map[this.rootUrl] = Array.from(this.expanded)
    await storageSet({ [STORAGE_EXPANDED]: map })
  }

  private async saveRecent(url: string) {
    this.recents = [url, ...this.recents.filter(r => r !== url)].slice(
      0,
      MAX_RECENT,
    )
    await storageSet({ [STORAGE_RECENT]: this.recents })
  }

  public async removeRecent(url: string) {
    this.recents = this.recents.filter(r => r !== url)
    await storageSet({ [STORAGE_RECENT]: this.recents })
    this.render()
  }

  /* ---------- picking ---------- */

  private async onFolderPicked(files: FileList) {
    this.loading = true
    this.notice = ''
    this.render()
    const rootUrl = await this.inferRootUrl(files).catch(() => null)
    if (rootUrl) {
      await this.openRoot(rootUrl)
      return
    }
    // Location unknown: browse the picked files in memory for this page only
    this.loading = false
    this.memoryMode = true
    this.rootUrl = null
    this.rootNode = this.buildTreeFromFileList(files)
    this.activeMemoryPath = null
    this.searchQuery = ''
    this.notice = this.localize('folder_not_remembered')
    this.render()
  }

  /**
   * Work out the absolute file:// url of the picked folder. The picker only
   * gives paths relative to the folder, so: (1) if the file open in this tab
   * is inside the folder, align the two paths; (2) otherwise look for a folder
   * with the same name and contents next to the current file or its parents.
   */
  private async inferRootUrl(files: FileList): Promise<string | null> {
    const firstRel = files[0].webkitRelativePath
    if (!firstRel) return null
    const rootName = firstRel.split('/')[0]
    const curSegs = this.currentFile.split('/')

    // (1) current file lives inside the picked folder
    for (let i = 0; i < files.length; i++) {
      const relSegs = files[i].webkitRelativePath.split('/')
      if (relSegs.length > curSegs.length) continue
      const tail = curSegs.slice(curSegs.length - relSegs.length)
      if (tail.every((seg, j) => decode(seg) === relSegs[j])) {
        return (
          curSegs.slice(0, curSegs.length - relSegs.length + 1).join('/') + '/'
        )
      }
    }

    // (2) look for a folder named rootName near the current file: in each
    // parent directory and one level below it (bounded number of listings)
    const topNames = new Set<string>()
    for (let i = 0; i < files.length; i++) {
      const segs = files[i].webkitRelativePath.split('/')
      if (segs.length > 1) topNames.add(segs[1])
    }
    let budget = MAX_SCAN_LISTINGS
    const list = async (url: string): Promise<DirEntry[] | null> => {
      if (budget-- <= 0) return null
      return listDir(url).catch(() => null)
    }
    const matches = async (candidate: string) => {
      const entries = await list(candidate)
      if (!entries) return false
      const names = new Set(entries.map(e => e.name))
      return Array.from(topNames).every(n => names.has(n))
    }
    let dir: string | null = dirOf(this.currentFile)
    for (let depth = 0; dir && depth < MAX_SIBLING_SCAN; depth++) {
      const entries = await list(dir)
      if (!entries) break
      const dirs = entries.filter(e => e.isDir && !shouldSkipDir(e.name))
      const direct = dirs.find(e => e.name === rootName)
      if (direct) {
        const candidate = dir + encodeURIComponent(rootName) + '/'
        if (await matches(candidate)) return candidate
      }
      for (const sub of dirs) {
        if (sub.name === rootName) continue
        const subUrl = dir + encodeURIComponent(sub.name) + '/'
        const subEntries = await list(subUrl)
        if (!subEntries) break
        if (subEntries.some(e => e.isDir && e.name === rootName)) {
          const candidate = subUrl + encodeURIComponent(rootName) + '/'
          if (await matches(candidate)) return candidate
        }
      }
      dir = parentOf(dir)
    }
    return null
  }

  private buildTreeFromFileList(files: FileList): FileTreeNode {
    const rootName = files[0].webkitRelativePath.split('/')[0] || 'Folder'
    const root: FileTreeNode = {
      name: rootName,
      path: rootName,
      isDirectory: true,
      children: [],
      expanded: true,
    }
    for (let i = 0; i < files.length; i++) {
      const file = files[i]
      if (!isMarkdownFile(file.name)) continue
      const parts = (file.webkitRelativePath || file.name).split('/')
      if (parts.slice(0, -1).some(shouldSkipDir)) continue
      let node = root
      let path = parts[0]
      for (let j = 1; j < parts.length; j++) {
        path += `/${parts[j]}`
        if (j === parts.length - 1) {
          node.children.push({
            name: parts[j],
            path,
            isDirectory: false,
            fileObj: file,
          })
        } else {
          let next = node.children.find(
            c => c.isDirectory && c.name === parts[j],
          )
          if (!next) {
            next = {
              name: parts[j],
              path,
              isDirectory: true,
              children: [],
              expanded: true,
            }
            node.children.push(next)
          }
          node = next
        }
      }
    }
    sortTree(root)
    return root
  }

  /* ---------- opening by path ---------- */

  public async openRoot(url: string, remember: boolean = true) {
    if (!url.endsWith('/')) url += '/'
    this.loading = true
    this.notice = ''
    this.showRecents = false
    this.searchQuery = ''
    this.fullyLoaded = false
    this.memoryMode = false
    this.activeMemoryPath = null
    this.render()

    const node: FileTreeNode = {
      name: nameOf(url),
      path: displayPath(url),
      url,
      isDirectory: true,
      expanded: true,
      children: [],
    }
    try {
      await this.loadChildren(node)
      this.rootUrl = url
      this.rootNode = node
      if (remember) {
        this.expanded = new Set()
        await storageSet({ [STORAGE_ROOT]: url })
        await this.saveRecent(url)
      }
      await this.expandToCurrentFile()
    } catch (err) {
      console.error('Failed to list folder', err)
      this.notice = this.localize('folder_not_found')
      if (remember) {
        this.recents = this.recents.filter(r => r !== url)
        await storageSet({ [STORAGE_RECENT]: this.recents })
      }
    }
    this.loading = false
    this.render()
  }

  public closeFolder() {
    const hadMemoryFile = this.memoryMode && !!this.activeMemoryPath
    this.rootUrl = null
    this.rootNode = null
    this.memoryMode = false
    this.activeMemoryPath = null
    this.expanded = new Set()
    this.notice = ''
    this.searchQuery = ''
    this.fileInput.value = ''
    storageSet({ [STORAGE_ROOT]: null })
    this.render()
    if (hadMemoryFile) this.callbacks.onFolderClosed?.()
  }

  private async loadChildren(node: FileTreeNode) {
    if (node.loaded || !node.url) return
    node.loading = true
    try {
      const entries = await listDir(node.url)
      node.children = entries
        .filter(e =>
          e.isDir ? !shouldSkipDir(e.name) : isMarkdownFile(e.name),
        )
        .map(e => {
          const url =
            node.url + encodeURIComponent(e.name) + (e.isDir ? '/' : '')
          return {
            name: e.name,
            path: displayPath(url),
            url,
            isDirectory: e.isDir,
            expanded: e.isDir ? this.expanded.has(url) : undefined,
            children: e.isDir ? [] : undefined,
            loaded: e.isDir ? false : undefined,
          } as FileTreeNode
        })
      sortNodes(node.children)
      node.loaded = true
    } finally {
      node.loading = false
    }
    // Restore previously expanded sub folders
    await Promise.all(
      node.children
        .filter(c => c.isDirectory && c.expanded)
        .map(c => this.loadChildren(c).catch(() => {})),
    )
  }

  /** Expand the directories leading to the file currently open in this tab */
  private async expandToCurrentFile() {
    if (!this.rootNode || !this.rootUrl) return
    const cur = decode(this.currentFile)
    const root = decode(this.rootUrl)
    if (!cur.startsWith(root)) return
    const segments = cur.slice(root.length).split('/').slice(0, -1)
    let node = this.rootNode
    for (const seg of segments) {
      if (!node.loaded) await this.loadChildren(node)
      const next = node.children?.find(
        c => c.isDirectory && sameUrl(c.url, node.url + seg + '/'),
      )
      if (!next) return
      next.expanded = true
      this.expanded.add(next.url)
      node = next
    }
    if (!node.loaded) await this.loadChildren(node)
    this.persistExpanded()
  }

  /** Load the whole tree (bounded) so search can match nested files */
  private async ensureFullyLoaded() {
    if (this.fullyLoaded || !this.rootNode || this.memoryMode) return
    this.fullyLoaded = true
    let count = 0
    const walk = async (node: FileTreeNode) => {
      if (count++ > MAX_SEARCH_DIRS) return
      if (!node.loaded) await this.loadChildren(node).catch(() => {})
      const dirs = (node.children || []).filter(c => c.isDirectory)
      await Promise.all(dirs.map(walk))
    }
    await walk(this.rootNode)
    this.render()
  }

  /* ---------- interaction ---------- */

  private async toggleDir(node: FileTreeNode) {
    node.expanded = !node.expanded
    if (this.memoryMode) {
      this.render()
      return
    }
    if (node.expanded) {
      this.expanded.add(node.url)
      if (!node.loaded) {
        this.render()
        try {
          await this.loadChildren(node)
        } catch (err) {
          console.error('Failed to list folder', err)
          this.notice = this.localize('folder_not_found')
        }
      }
    } else {
      this.expanded.delete(node.url)
    }
    this.persistExpanded()
    this.render()
  }

  private async selectFile(node: FileTreeNode) {
    if (node.fileObj) {
      try {
        const content = await node.fileObj.text()
        this.activeMemoryPath = node.path
        this.callbacks.onFileSelected(content, node.name, node.path)
        this.render()
      } catch (err) {
        console.error('Error reading markdown file:', err)
      }
      return
    }
    if (!node.url || sameUrl(node.url, this.currentFile)) return
    window.location.href = node.url
  }

  /* ---------- rendering ---------- */

  private renderRecentList(): HTMLElement {
    const list = document.createElement('ul')
    list.className = className.FOLDER_RECENT_LIST

    if (this.recents.length === 0) {
      const empty = document.createElement('li')
      empty.className = 'md-reader__folder-recent-empty'
      empty.textContent = this.localize('no_recent_folders')
      list.appendChild(empty)
      return list
    }

    for (const url of this.recents) {
      const li = document.createElement('li')
      li.className = className.FOLDER_RECENT_ITEM
      if (url === this.rootUrl) li.classList.add('current')

      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'md-reader__folder-recent-open'
      btn.title = displayPath(url)
      btn.innerHTML = `${icons.folder(
        13,
      )}<span class="md-reader__folder-label"></span>`
      btn.querySelector('span').textContent = nameOf(url)
      btn.onclick = e => {
        e.preventDefault()
        e.stopPropagation()
        this.openRoot(url)
      }

      const remove = document.createElement('button')
      remove.type = 'button'
      remove.className = 'md-reader__folder-recent-remove'
      remove.title = this.localize('btn_remove_recent')
      remove.innerHTML = icons.close(11)
      remove.onclick = e => {
        e.preventDefault()
        e.stopPropagation()
        this.removeRecent(url)
      }

      li.appendChild(btn)
      li.appendChild(remove)
      list.appendChild(li)
    }
    return list
  }

  private renderNotice(): HTMLElement | null {
    if (!this.notice) return null
    const el = document.createElement('div')
    el.className = 'md-reader__folder-notice'
    el.textContent = this.notice
    return el
  }

  private renderEmpty(wrap: HTMLElement) {
    const emptyDiv = document.createElement('div')
    emptyDiv.className = className.FOLDER_EMPTY

    const icon = document.createElement('div')
    icon.className = 'md-reader__folder-empty-icon'
    icon.innerHTML = icons.folder(36, 1.8)

    const title = document.createElement('div')
    title.className = 'md-reader__folder-empty-title'
    title.textContent = this.rootNode
      ? this.localize('no_files_found')
      : this.localize('no_folder_selected')

    const desc = document.createElement('div')
    desc.className = 'md-reader__folder-empty-desc'
    desc.textContent = this.localize('folder_desc')

    const openBtn = document.createElement('button')
    openBtn.className = 'md-reader__folder-open-btn'
    openBtn.type = 'button'
    openBtn.innerHTML = `${icons.folder(15)} <span>${this.localize(
      'btn_open_folder',
    )}</span>`
    openBtn.onclick = e => {
      e.preventDefault()
      e.stopPropagation()
      this.pickFolder()
    }

    emptyDiv.appendChild(icon)
    emptyDiv.appendChild(title)
    emptyDiv.appendChild(desc)
    emptyDiv.appendChild(openBtn)
    const notice = this.renderNotice()
    notice && emptyDiv.appendChild(notice)
    wrap.appendChild(emptyDiv)

    if (this.recents.length > 0) {
      const box = document.createElement('div')
      box.className = className.FOLDER_RECENT
      const heading = document.createElement('div')
      heading.className = 'md-reader__folder-recent-title'
      heading.innerHTML = `${icons.clock(12)}<span>${this.localize(
        'recent_folders',
      )}</span>`
      box.appendChild(heading)
      box.appendChild(this.renderRecentList())
      wrap.appendChild(box)
    }
  }

  public render() {
    this.container.innerHTML = ''
    const wrap = document.createElement('div')
    wrap.className = className.FOLDER_WRAP

    if (this.loading) {
      const loading = document.createElement('div')
      loading.className = 'md-reader__folder-no-match'
      loading.textContent = this.localize('folder_loading')
      wrap.appendChild(loading)
      this.container.appendChild(wrap)
      return
    }

    if (
      !this.rootNode ||
      !this.rootNode.children ||
      this.rootNode.children.length === 0
    ) {
      this.renderEmpty(wrap)
      this.container.appendChild(wrap)
      return
    }

    // Header
    const header = document.createElement('div')
    header.className = className.FOLDER_HEADER

    const rootInfo = document.createElement('div')
    rootInfo.className = 'md-reader__folder-root-info'
    rootInfo.innerHTML = `${icons.folder(
      14,
    )}<span class="md-reader__folder-root-name"></span>`
    const rootName = rootInfo.querySelector('span')
    rootName.textContent = this.rootNode.name
    rootName.title = this.rootNode.path

    const actions = document.createElement('div')
    actions.className = 'md-reader__folder-actions'

    const action = (title: string, html: string, onClick: () => void) => {
      const btn = document.createElement('button')
      btn.className = 'md-reader__folder-action-btn'
      btn.type = 'button'
      btn.title = title
      btn.innerHTML = html
      btn.onclick = e => {
        e.preventDefault()
        e.stopPropagation()
        onClick()
      }
      actions.appendChild(btn)
      return btn
    }

    const recentBtn = action(
      this.localize('recent_folders'),
      icons.clock(13),
      () => {
        this.showRecents = !this.showRecents
        this.render()
      },
    )
    if (this.showRecents) recentBtn.classList.add('active')
    action(this.localize('btn_change_folder'), icons.change(13), () =>
      this.pickFolder(),
    )
    action(this.localize('btn_close_folder'), icons.close(13), () =>
      this.closeFolder(),
    )

    header.appendChild(rootInfo)
    header.appendChild(actions)
    wrap.appendChild(header)

    if (this.showRecents) {
      const recentWrap = document.createElement('div')
      recentWrap.className = `${className.FOLDER_RECENT} dropdown`
      recentWrap.appendChild(this.renderRecentList())
      wrap.appendChild(recentWrap)
    }

    const notice = this.renderNotice()
    notice && wrap.appendChild(notice)

    // Search
    const searchWrap = document.createElement('div')
    searchWrap.className = className.FOLDER_SEARCH
    const searchInput = document.createElement('input')
    searchInput.type = 'text'
    searchInput.placeholder = this.localize('placeholder_search')
    searchInput.value = this.searchQuery
    searchInput.oninput = (e: any) => {
      this.searchQuery = e.target.value
      if (this.searchQuery) this.ensureFullyLoaded()
      this.renderTree(treeList)
    }
    searchWrap.appendChild(searchInput)
    wrap.appendChild(searchWrap)

    // Tree
    const treeList = document.createElement('ul')
    treeList.className = className.FOLDER_TREE
    this.renderTree(treeList)
    wrap.appendChild(treeList)
    this.container.appendChild(wrap)
    revealActive(treeList)
  }

  private renderTree(treeList: HTMLElement) {
    treeList.innerHTML = ''
    if (!this.rootNode) return

    const filtered = filterNode(this.rootNode, this.searchQuery)
    if (!filtered || !filtered.children || filtered.children.length === 0) {
      const noMatch = document.createElement('div')
      noMatch.className = 'md-reader__folder-no-match'
      noMatch.textContent = this.localize('no_files_found')
      treeList.appendChild(noMatch)
      return
    }

    renderNodeChildren(filtered.children, treeList, 0, {
      activePath: this.memoryMode
        ? this.activeMemoryPath
        : displayPath(this.currentFile),
      onToggleDir: node => this.toggleDir(node),
      onSelectFile: node => this.selectFile(node),
      loadingText: this.localize('folder_loading'),
    })
  }
}
