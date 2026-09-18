import className from '@/config/class-name'
import i18n from '@/config/i18n'
import {
  type FileTreeNode,
  filterNode,
  icons,
  isMarkdownFile,
  renderNodeChildren,
  shouldSkipDir,
  sortTree,
} from '@/core/folder-tree'

/**
 * Folder browser for http(s) pages, backed by the File System Access API
 * (directory handles persisted in IndexedDB for the recent list).
 * `file://` pages use PathFolderManager instead.
 */

/* Minimal File System Access API typings (not fully covered by lib.dom in TS 4.x) */
type FsPermission = 'granted' | 'denied' | 'prompt'
interface FsHandle {
  kind: 'file' | 'directory'
  name: string
  isSameEntry(other: FsHandle): Promise<boolean>
  queryPermission(opts?: { mode: 'read' | 'readwrite' }): Promise<FsPermission>
  requestPermission(opts?: {
    mode: 'read' | 'readwrite'
  }): Promise<FsPermission>
}
interface FsFileHandle extends FsHandle {
  kind: 'file'
  getFile(): Promise<File>
}
interface FsDirHandle extends FsHandle {
  kind: 'directory'
  entries(): AsyncIterableIterator<[string, FsFileHandle | FsDirHandle]>
}

export interface RecentFolder {
  id: string
  name: string
  handle: FsDirHandle
  lastOpened: number
}

const MAX_RECENT = 10
const MAX_DEPTH = 16
const DB_NAME = 'md-reader'
const DB_STORE = 'recent-folders'

function hasFsAccess(): boolean {
  return typeof (window as any).showDirectoryPicker === 'function'
}

/* ---------- IndexedDB persistence for recent folder handles ---------- */

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(DB_STORE)) {
        db.createObjectStore(DB_STORE, { keyPath: 'id' })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

function withStore<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T> | void,
): Promise<T> {
  return openDb().then(
    db =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(DB_STORE, mode)
        const req = fn(tx.objectStore(DB_STORE))
        tx.oncomplete = () => resolve(req ? req.result : undefined)
        tx.onerror = () => reject(tx.error)
        tx.onabort = () => reject(tx.error)
      }),
  )
}

async function loadRecents(): Promise<RecentFolder[]> {
  try {
    const list = await withStore<RecentFolder[]>('readonly', s => s.getAll())
    return (list || []).sort((a, b) => b.lastOpened - a.lastOpened)
  } catch {
    return []
  }
}

function deleteRecent(id: string): Promise<void> {
  return withStore<undefined>('readwrite', s => {
    s.delete(id)
  }).catch(() => {})
}

/* ---------- FolderManager ---------- */

interface FolderCallbacks {
  onFileSelected: (content: string, name: string, path: string) => void
  onFolderClosed?: () => void
}

export class FolderManager {
  private rootNode: FileTreeNode | null = null
  private activeNode: FileTreeNode | null = null
  private activeLastModified: number = 0
  private searchQuery: string = ''
  private recents: RecentFolder[] = []
  private showRecents: boolean = false
  private loading: boolean = false
  private notice: string = ''
  private callbacks: FolderCallbacks
  private localize: (key: string) => string = i18n()
  private container: HTMLElement
  private fileInput: HTMLInputElement
  private fsAccess: boolean = hasFsAccess()

  constructor(
    container: HTMLElement,
    callbacks: FolderCallbacks,
    language?: string,
  ) {
    this.container = container
    this.callbacks = callbacks
    this.localize = i18n(language)

    // Fallback picker for browsers without the File System Access API
    this.fileInput = document.createElement('input')
    this.fileInput.type = 'file'
    // @ts-ignore
    this.fileInput.webkitdirectory = true
    // @ts-ignore
    this.fileInput.directory = true
    this.fileInput.multiple = true
    this.fileInput.style.display = 'none'
    this.fileInput.addEventListener('change', () => {
      if (this.fileInput.files && this.fileInput.files.length > 0) {
        this.rootNode = this.buildTreeFromFileList(this.fileInput.files)
        this.searchQuery = ''
        this.render()
      }
    })
    document.body.appendChild(this.fileInput)

    this.render()
    this.restoreLastFolder()
  }

  public setLanguage(language?: string) {
    this.localize = i18n(language)
    this.render()
  }

  public hasActiveFile(): boolean {
    return !!this.activeNode
  }

  /**
   * Re-read the active file if it changed on disk (used by auto refresh).
   * Resolves `null` when nothing changed or nothing is selected.
   */
  public async readActiveFileIfChanged(): Promise<string | null> {
    const node = this.activeNode
    if (!node || !node.fileHandle) return null
    try {
      const file = await node.fileHandle.getFile()
      if (file.lastModified === this.activeLastModified) return null
      this.activeLastModified = file.lastModified
      return await file.text()
    } catch {
      return null
    }
  }

  /* ---------- opening folders ---------- */

  public async pickFolder() {
    if (!this.fsAccess) {
      this.fileInput.value = ''
      this.fileInput.click()
      return
    }
    let handle: FsDirHandle
    try {
      handle = await (window as any).showDirectoryPicker({ mode: 'read' })
    } catch (err) {
      if (err && err.name === 'AbortError') return
      // API blocked on this page (e.g. insecure context) - fall back
      console.warn('showDirectoryPicker failed, falling back to input', err)
      this.fsAccess = false
      this.fileInput.value = ''
      this.fileInput.click()
      return
    }
    await this.openHandle(handle)
  }

  public async openRecent(recent: RecentFolder) {
    const handle = recent.handle
    try {
      let perm = await handle.queryPermission({ mode: 'read' })
      if (perm !== 'granted') {
        perm = await handle.requestPermission({ mode: 'read' })
      }
      if (perm !== 'granted') {
        this.setNotice(this.localize('folder_permission_denied'))
        return
      }
    } catch (err) {
      console.warn('Recent folder permission error', err)
      this.setNotice(this.localize('folder_permission_denied'))
      return
    }
    await this.openHandle(handle, recent.id)
  }

  private async openHandle(handle: FsDirHandle, existingId?: string) {
    this.loading = true
    this.notice = ''
    this.showRecents = false
    this.render()
    try {
      const root = await this.buildTreeFromHandle(handle)
      this.rootNode = root
      this.activeNode = null
      this.searchQuery = ''
      await this.saveRecent(handle, existingId)
    } catch (err) {
      console.error('Failed to read folder', err)
      // Folder was moved/deleted: drop it from recents
      if (existingId && err && err.name === 'NotFoundError') {
        await deleteRecent(existingId)
        this.recents = this.recents.filter(r => r.id !== existingId)
      }
      this.notice = this.localize('folder_not_found')
    }
    this.loading = false
    this.render()
  }

  private async restoreLastFolder() {
    this.recents = await loadRecents()
    this.render()
    if (!this.fsAccess) return
    const last = this.recents[0]
    if (!last) return
    try {
      // Only restore silently when Chrome already granted access (no prompt)
      const perm = await last.handle.queryPermission({ mode: 'read' })
      if (perm === 'granted') {
        await this.openHandle(last.handle, last.id)
      }
    } catch {
      /* ignore */
    }
  }

  private async saveRecent(handle: FsDirHandle, existingId?: string) {
    if (!this.fsAccess) return
    let id = existingId
    if (!id) {
      for (const r of this.recents) {
        try {
          if (await r.handle.isSameEntry(handle)) {
            id = r.id
            break
          }
        } catch {
          /* ignore */
        }
      }
    }
    const entry: RecentFolder = {
      id: id || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name: handle.name,
      handle,
      lastOpened: Date.now(),
    }
    this.recents = [entry, ...this.recents.filter(r => r.id !== entry.id)]
    const overflow = this.recents.splice(MAX_RECENT)
    try {
      await withStore<undefined>('readwrite', s => {
        s.put(entry)
        overflow.forEach(r => s.delete(r.id))
      })
    } catch (err) {
      console.warn('Unable to persist recent folder', err)
    }
  }

  public async removeRecent(id: string) {
    this.recents = this.recents.filter(r => r.id !== id)
    await deleteRecent(id)
    this.render()
  }

  private setNotice(text: string) {
    this.notice = text
    this.render()
  }

  /* ---------- tree building ---------- */

  private async buildTreeFromHandle(
    handle: FsDirHandle,
    path: string = handle.name,
    depth: number = 0,
  ): Promise<FileTreeNode> {
    const node: FileTreeNode = {
      name: handle.name,
      path,
      isDirectory: true,
      children: [],
      expanded: depth === 0,
    }
    if (depth > MAX_DEPTH) return node

    for await (const [name, child] of handle.entries()) {
      if (child.kind === 'directory') {
        if (shouldSkipDir(name)) continue
        const sub = await this.buildTreeFromHandle(
          child as FsDirHandle,
          `${path}/${name}`,
          depth + 1,
        )
        // Prune folders without markdown files
        if (sub.children && sub.children.length > 0) {
          node.children.push(sub)
        }
      } else if (isMarkdownFile(name)) {
        node.children.push({
          name,
          path: `${path}/${name}`,
          isDirectory: false,
          fileHandle: child as FsFileHandle,
        })
      }
    }
    sortTree(node)
    return node
  }

  private buildTreeFromFileList(files: FileList): FileTreeNode {
    let rootName = 'Folder'
    if (files.length > 0 && files[0].webkitRelativePath) {
      rootName = files[0].webkitRelativePath.split('/')[0]
    }

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

      const relativePath = file.webkitRelativePath || file.name
      const parts = relativePath.split('/')

      if (parts.slice(0, -1).some(shouldSkipDir)) continue

      if (parts.length === 1) {
        root.children.push({
          name: file.name,
          path: file.name,
          isDirectory: false,
          fileObj: file,
        })
        continue
      }

      let currentNode = root
      let currentPath = parts[0]

      for (let j = 1; j < parts.length; j++) {
        const part = parts[j]
        currentPath += `/${part}`
        const isFile = j === parts.length - 1

        currentNode.children = currentNode.children || []
        if (isFile) {
          currentNode.children.push({
            name: part,
            path: currentPath,
            isDirectory: false,
            fileObj: file,
          })
        } else {
          let nextNode = currentNode.children.find(
            c => c.isDirectory && c.name === part,
          )
          if (!nextNode) {
            nextNode = {
              name: part,
              path: currentPath,
              isDirectory: true,
              children: [],
              expanded: true,
            }
            currentNode.children.push(nextNode)
          }
          currentNode = nextNode
        }
      }
    }

    sortTree(root)
    return root
  }

  /* ---------- selection ---------- */

  public async selectFile(node: FileTreeNode) {
    if (node.isDirectory) {
      node.expanded = !node.expanded
      this.render()
      return
    }

    try {
      let content = ''
      if (node.fileHandle) {
        const file = await node.fileHandle.getFile()
        this.activeLastModified = file.lastModified
        content = await file.text()
      } else if (node.fileObj) {
        this.activeLastModified = node.fileObj.lastModified
        content = await node.fileObj.text()
      }

      this.activeNode = node
      this.callbacks.onFileSelected(content, node.name, node.path)
      this.render()
    } catch (err) {
      console.error('Error reading markdown file:', err)
      this.setNotice(this.localize('folder_not_found'))
    }
  }

  public closeFolder() {
    const hadActive = !!this.activeNode
    this.rootNode = null
    this.activeNode = null
    this.searchQuery = ''
    this.notice = ''
    this.fileInput.value = ''
    this.render()
    if (hadActive) this.callbacks.onFolderClosed?.()
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

    for (const recent of this.recents) {
      const li = document.createElement('li')
      li.className = className.FOLDER_RECENT_ITEM
      if (this.rootNode && this.rootNode.name === recent.name) {
        li.classList.add('current')
      }

      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'md-reader__folder-recent-open'
      btn.title = recent.name
      btn.innerHTML = `${icons.folder(
        13,
      )}<span class="md-reader__folder-label">${recent.name}</span>`
      btn.onclick = e => {
        e.preventDefault()
        e.stopPropagation()
        this.openRecent(recent)
      }

      const remove = document.createElement('button')
      remove.type = 'button'
      remove.className = 'md-reader__folder-recent-remove'
      remove.title = this.localize('btn_remove_recent')
      remove.innerHTML = icons.close(11)
      remove.onclick = e => {
        e.preventDefault()
        e.stopPropagation()
        this.removeRecent(recent.id)
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
      // Empty state
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

      // Recent folders quick pick
      if (this.fsAccess && this.recents.length > 0) {
        const recentWrap = document.createElement('div')
        recentWrap.className = className.FOLDER_RECENT
        const heading = document.createElement('div')
        heading.className = 'md-reader__folder-recent-title'
        heading.innerHTML = `${icons.clock(12)}<span>${this.localize(
          'recent_folders',
        )}</span>`
        recentWrap.appendChild(heading)
        recentWrap.appendChild(this.renderRecentList())
        wrap.appendChild(recentWrap)
      }

      this.container.appendChild(wrap)
      return
    }

    // Header Bar
    const header = document.createElement('div')
    header.className = className.FOLDER_HEADER

    const rootInfo = document.createElement('div')
    rootInfo.className = 'md-reader__folder-root-info'
    rootInfo.innerHTML = `${icons.folder(
      14,
    )}<span class="md-reader__folder-root-name" title="${this.rootNode.name}">${
      this.rootNode.name
    }</span>`

    const actions = document.createElement('div')
    actions.className = 'md-reader__folder-actions'

    if (this.fsAccess) {
      const recentBtn = document.createElement('button')
      recentBtn.className = 'md-reader__folder-action-btn'
      if (this.showRecents) recentBtn.classList.add('active')
      recentBtn.type = 'button'
      recentBtn.title = this.localize('recent_folders')
      recentBtn.innerHTML = icons.clock(13)
      recentBtn.onclick = e => {
        e.preventDefault()
        e.stopPropagation()
        this.showRecents = !this.showRecents
        this.render()
      }
      actions.appendChild(recentBtn)
    }

    const changeBtn = document.createElement('button')
    changeBtn.className = 'md-reader__folder-action-btn'
    changeBtn.type = 'button'
    changeBtn.title = this.localize('btn_change_folder')
    changeBtn.innerHTML = icons.change(13)
    changeBtn.onclick = e => {
      e.preventDefault()
      e.stopPropagation()
      this.pickFolder()
    }

    const closeBtn = document.createElement('button')
    closeBtn.className = 'md-reader__folder-action-btn'
    closeBtn.type = 'button'
    closeBtn.title = this.localize('btn_close_folder')
    closeBtn.innerHTML = icons.close(13)
    closeBtn.onclick = e => {
      e.preventDefault()
      e.stopPropagation()
      this.closeFolder()
    }

    actions.appendChild(changeBtn)
    actions.appendChild(closeBtn)
    header.appendChild(rootInfo)
    header.appendChild(actions)
    wrap.appendChild(header)

    // Recent folders dropdown
    if (this.showRecents) {
      const recentWrap = document.createElement('div')
      recentWrap.className = `${className.FOLDER_RECENT} dropdown`
      recentWrap.appendChild(this.renderRecentList())
      wrap.appendChild(recentWrap)
    }

    const notice = this.renderNotice()
    notice && wrap.appendChild(notice)

    // Search Input
    const searchWrap = document.createElement('div')
    searchWrap.className = className.FOLDER_SEARCH
    const searchInput = document.createElement('input')
    searchInput.type = 'text'
    searchInput.placeholder = this.localize('placeholder_search')
    searchInput.value = this.searchQuery
    searchInput.oninput = (e: any) => {
      this.searchQuery = e.target.value
      this.renderTree(treeList)
    }
    searchWrap.appendChild(searchInput)
    wrap.appendChild(searchWrap)

    // Tree List
    const treeList = document.createElement('ul')
    treeList.className = className.FOLDER_TREE
    this.renderTree(treeList)

    wrap.appendChild(treeList)
    this.container.appendChild(wrap)
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
      activePath: this.activeNode ? this.activeNode.path : null,
      onToggleDir: node => {
        node.expanded = !node.expanded
        this.render()
      },
      onSelectFile: node => this.selectFile(node),
      loadingText: this.localize('folder_loading'),
    })
  }
}
