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
} from '@/core/folder-tree'

/**
 * Folder browser for local `file://` pages.
 *
 * No picker and no permission prompt: the extension already has read access to
 * file URLs, so directories are listed by fetching Chrome's directory listing
 * through the background script. The chosen root is persisted in
 * chrome.storage and files are opened by navigating to their file:// URL, so
 * the tree survives reloads and the current document is always highlighted.
 */

const MAX_RECENT = 10
const MAX_SEARCH_DIRS = 400
const STORAGE_ROOT = 'folderRoot'
const STORAGE_EXPANDED = 'folderExpanded'
const STORAGE_RECENT = 'recentFolders'

interface DirEntry {
  name: string
  isDir: boolean
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

function nameOf(dirUrl: string): string {
  const trimmed = dirUrl.replace(/\/+$/, '')
  const seg = trimmed.slice(trimmed.lastIndexOf('/') + 1)
  try {
    return decodeURIComponent(seg) || '/'
  } catch {
    return seg || '/'
  }
}

/** "/home/me/docs" | "C:\\docs" | "file:///x" -> file:// directory url */
function pathToUrl(input: string): string | null {
  let p = input.trim()
  if (!p) return null
  if (/^file:\/\//i.test(p)) return p.endsWith('/') ? p : p + '/'
  p = p.replace(/\\/g, '/')
  if (/^[a-zA-Z]:\//.test(p)) p = '/' + p
  if (!p.startsWith('/')) return null
  const url =
    'file://' +
    p
      .split('/')
      .map(seg => encodeURIComponent(seg).replace(/%3A/gi, ':'))
      .join('/')
  return url.endsWith('/') ? url : url + '/'
}

function displayPath(url: string): string {
  try {
    return decodeURIComponent(url.replace(/^file:\/\//, ''))
  } catch {
    return url
  }
}

export class PathFolderManager {
  private rootUrl: string | null = null
  private rootNode: FileTreeNode | null = null
  private expanded: Set<string> = new Set()
  private recents: string[] = []
  private searchQuery: string = ''
  private showRecents: boolean = false
  private choosing: boolean = false
  private loading: boolean = false
  private notice: string = ''
  private fullyLoaded: boolean = false
  private localize: (key: string) => string = i18n()
  private container: HTMLElement
  private currentFile: string = window.location.href.split(/[?#]/)[0]

  constructor(container: HTMLElement, language?: string) {
    this.container = container
    this.localize = i18n(language)
    this.render()
    this.restore()
  }

  public setLanguage(language?: string) {
    this.localize = i18n(language)
    this.render()
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

  /* ---------- opening ---------- */

  public async openRoot(url: string, remember: boolean = true) {
    if (!url.endsWith('/')) url += '/'
    this.loading = true
    this.notice = ''
    this.choosing = false
    this.showRecents = false
    this.searchQuery = ''
    this.fullyLoaded = false
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
    this.rootUrl = null
    this.rootNode = null
    this.expanded = new Set()
    this.notice = ''
    this.searchQuery = ''
    storageSet({ [STORAGE_ROOT]: null })
    this.render()
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
    if (!this.currentFile.startsWith(this.rootUrl)) return
    const rel = this.currentFile.slice(this.rootUrl.length)
    const segments = rel.split('/').slice(0, -1)
    let node = this.rootNode
    for (const seg of segments) {
      if (!node.loaded) await this.loadChildren(node)
      const next = node.children?.find(
        c => c.isDirectory && c.url === node.url + seg + '/',
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
    if (this.fullyLoaded || !this.rootNode) return
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

  private selectFile(node: FileTreeNode) {
    if (!node.url || node.url === this.currentFile) return
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

  /** Ancestor directories of the current file, nearest first */
  private renderAncestorList(): HTMLElement {
    const list = document.createElement('ul')
    list.className = className.FOLDER_RECENT_LIST
    let dir: string | null = dirOf(this.currentFile)
    let depth = 0
    while (dir && depth < 8) {
      const url = dir
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
      btn.querySelector('span').textContent = displayPath(url)
      btn.onclick = e => {
        e.preventDefault()
        e.stopPropagation()
        this.openRoot(url)
      }
      li.appendChild(btn)
      list.appendChild(li)
      dir = parentOf(dir)
      depth++
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

  private renderChooser(wrap: HTMLElement) {
    const emptyDiv = document.createElement('div')
    emptyDiv.className = className.FOLDER_EMPTY

    const icon = document.createElement('div')
    icon.className = 'md-reader__folder-empty-icon'
    icon.innerHTML = icons.folder(36, 1.8)

    const title = document.createElement('div')
    title.className = 'md-reader__folder-empty-title'
    title.textContent = this.localize(
      this.choosing ? 'btn_open_folder' : 'no_folder_selected',
    )

    const desc = document.createElement('div')
    desc.className = 'md-reader__folder-empty-desc'
    desc.textContent = this.localize('folder_desc_path')

    // Path input + open button
    const form = document.createElement('form')
    form.className = 'md-reader__folder-path-form'
    const input = document.createElement('input')
    input.type = 'text'
    input.spellcheck = false
    input.placeholder = this.localize('placeholder_folder_path')
    input.value = displayPath(this.rootUrl || dirOf(this.currentFile))
    const openBtn = document.createElement('button')
    openBtn.className = 'md-reader__folder-open-btn'
    openBtn.type = 'submit'
    openBtn.innerHTML = `${icons.folder(15)} <span>${this.localize(
      'btn_open_folder',
    )}</span>`
    form.appendChild(input)
    form.appendChild(openBtn)
    form.onsubmit = e => {
      e.preventDefault()
      const url = pathToUrl(input.value)
      if (!url) {
        this.notice = this.localize('folder_not_found')
        this.render()
        return
      }
      this.openRoot(url)
    }

    emptyDiv.appendChild(icon)
    emptyDiv.appendChild(title)
    emptyDiv.appendChild(desc)
    emptyDiv.appendChild(form)
    const notice = this.renderNotice()
    notice && emptyDiv.appendChild(notice)
    wrap.appendChild(emptyDiv)

    if (this.choosing) {
      const back = document.createElement('button')
      back.type = 'button'
      back.className = 'md-reader__folder-open-btn secondary'
      back.innerHTML = `${icons.close(13)} <span>${this.localize(
        'btn_cancel',
      )}</span>`
      back.onclick = () => {
        this.choosing = false
        this.render()
      }
      emptyDiv.appendChild(back)
    }

    const section = (titleKey: string, list: HTMLElement) => {
      const box = document.createElement('div')
      box.className = className.FOLDER_RECENT
      const heading = document.createElement('div')
      heading.className = 'md-reader__folder-recent-title'
      heading.innerHTML = `${
        titleKey === 'recent_folders' ? icons.clock(12) : icons.up(12)
      }<span>${this.localize(titleKey)}</span>`
      box.appendChild(heading)
      box.appendChild(list)
      wrap.appendChild(box)
    }

    section('open_parent_folder', this.renderAncestorList())
    if (this.recents.length > 0) {
      section('recent_folders', this.renderRecentList())
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

    if (!this.rootNode || this.choosing) {
      this.renderChooser(wrap)
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

    const parent = parentOf(this.rootUrl)
    if (parent) {
      action(this.localize('btn_parent_folder'), icons.up(13), () =>
        this.openRoot(parent),
      )
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
    action(this.localize('btn_change_folder'), icons.change(13), () => {
      this.choosing = true
      this.render()
    })
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
      activePath: displayPath(this.currentFile),
      onToggleDir: node => this.toggleDir(node),
      onSelectFile: node => this.selectFile(node),
      loadingText: this.localize('folder_loading'),
    })
  }
}
